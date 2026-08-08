"""The ranking engine: which videos a time window admits, and in what order."""

from datetime import datetime, timedelta, timezone

import pytest

from app.models import Video
from app.ranking import (
    HOT_HOUR_OFFSET,
    LIKE_PCT_FALLBACK_PRIOR,
    LIKE_PCT_PSEUDO_VIEWS,
    TICK_DAYS,
    filter_by_range,
    format_range,
    range_cutoffs,
    rank_videos,
    resolve_range,
    score_video,
)


def video(vid="v", *, hours_ago=1.0, views=1000, likes=10, channel="chan1", title=None):
    return Video(
        youtube_id=vid,
        channel_id=channel,
        title=title or f"Video {vid}",
        thumbnail_url="",
        published_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours_ago),
        duration_seconds=100,
        view_count=views,
        like_count=likes,
        is_short=False,
    )


# ── score_video ──────────────────────────────────────────────────────


def test_score_is_views_over_age():
    published = datetime.now(timezone.utc) - timedelta(hours=12)
    assert score_video(1200, published) == pytest.approx(1200 / (12 + HOT_HOUR_OFFSET), rel=1e-3)


def test_burn_in_stops_a_brand_new_video_exploding():
    """Without the offset a video published minutes ago divides by ~0.1h, and a
    handful of views tops the hot order."""
    now = datetime.now(timezone.utc)
    minutes_old = score_video(50, now - timedelta(minutes=6))
    day_old = score_video(5000, now - timedelta(hours=24))
    assert minutes_old < day_old
    # The offset alone accounts for it: the raw rate would win by a mile.
    assert 50 / 0.1 > 5000 / 24


def test_a_naive_published_at_is_read_as_utc():
    """The DB stores naive datetimes; subtracting one from an aware `now` would
    raise rather than rank."""
    naive = datetime.utcnow() - timedelta(hours=12)
    aware = datetime.now(timezone.utc) - timedelta(hours=12)
    assert score_video(1200, naive) == pytest.approx(score_video(1200, aware), rel=1e-3)


def test_a_video_from_the_future_does_not_score_negative():
    """A clock skew between YouTube's timestamp and ours shouldn't invert the
    sign and bury (or float) the video."""
    assert score_video(1000, datetime.now(timezone.utc) + timedelta(hours=5)) == 1000 / HOT_HOUR_OFFSET


# ── filter_by_range ──────────────────────────────────────────────────


def test_a_range_off_the_origin_is_a_discrete_bucket():
    """1-3 means 1–3 days ago, so today's video is NOT in it."""
    videos = [video("today", hours_ago=2), video("two-days", hours_ago=48)]
    kept = filter_by_range(videos, *resolve_range("1-3"))
    assert [v.youtube_id for v in kept] == ["two-days"]


def test_a_range_anchored_at_the_origin_accumulates_from_now():
    videos = [video("today", hours_ago=2), video("two-days", hours_ago=48)]
    kept = filter_by_range(videos, *resolve_range("0-3"))
    assert {v.youtube_id for v in kept} == {"today", "two-days"}


def test_anything_older_than_the_range_is_excluded_either_way():
    old = [video("old", hours_ago=24 * 10)]
    assert filter_by_range(old, *resolve_range("0-3")) == []
    assert filter_by_range(old, *resolve_range("1-3")) == []


@pytest.mark.parametrize("hi", TICK_DAYS[1:])
def test_every_range_admits_a_video_at_its_own_older_edge(hi):
    inside = video("in", hours_ago=hi * 24 - 1)
    outside = video("out", hours_ago=hi * 24 + 1)
    kept = {v.youtube_id for v in filter_by_range([inside, outside], *resolve_range(f"0-{hi}"))}
    assert kept == {"in"}


# ── resolve_range ────────────────────────────────────────────────────


def test_an_age_range_becomes_two_offsets():
    assert resolve_range("3-14") == (timedelta(days=3), timedelta(days=14))


def test_a_range_can_float_free_of_the_origin():
    """3d–2w ago: a band with both edges named, which the slider reaches."""
    videos = [video("recent", hours_ago=24), video("mid", hours_ago=24 * 8), video("old", hours_ago=24 * 40)]
    kept = filter_by_range(videos, *resolve_range("3-14"))
    assert [v.youtube_id for v in kept] == ["mid"]


def test_a_reversed_range_is_read_in_the_order_it_meant():
    assert resolve_range("14-3") == resolve_range("3-14")


def test_off_ladder_days_snap_to_the_nearest_tick():
    assert resolve_range("0-6") == (timedelta(days=0), timedelta(days=7))
    # A dead tie goes to the tighter window — the frontend breaks it the same way.
    assert resolve_range("0-5") == (timedelta(days=0), timedelta(days=3))


@pytest.mark.parametrize("bad", ["", None])
def test_no_age_falls_back_to_the_default_window(bad):
    assert resolve_range(bad) == (timedelta(days=0), timedelta(days=3))


@pytest.mark.parametrize("bad", ["7-7", "abc", "3", "3-", "-3", "1-2-3"])
def test_a_range_that_selects_nothing_is_rejected(bad):
    with pytest.raises(ValueError):
        resolve_range(bad)


def test_every_tick_pairs_with_the_one_after_it():
    for lo, hi in zip(TICK_DAYS, TICK_DAYS[1:]):
        assert resolve_range(f"{lo}-{hi}") == (timedelta(days=lo), timedelta(days=hi))


# ── the unbounded edge ───────────────────────────────────────────────


def test_all_leaves_the_older_edge_open():
    assert resolve_range("0-all") == (timedelta(days=0), None)
    assert resolve_range("30-all") == (timedelta(days=30), None)


def test_an_unbounded_range_reaches_videos_no_finite_one_could():
    """The ladder stops at a year; the archive does not."""
    ancient = video("ancient", hours_ago=24 * 365 * 8)
    assert filter_by_range([ancient], *resolve_range("0-365")) == []
    assert [v.youtube_id for v in filter_by_range([ancient], *resolve_range("0-all"))] == ["ancient"]


def test_an_unbounded_range_still_honours_its_newer_edge():
    videos = [video("today", hours_ago=2), video("ancient", hours_ago=24 * 365 * 8)]
    kept = filter_by_range(videos, *resolve_range("30-all"))
    assert [v.youtube_id for v in kept] == ["ancient"]


def test_only_the_older_edge_may_be_unbounded():
    """"all-30" would read as "from forever ago to 30 days ago", which is the
    same range spelled backwards — and an unbounded NEWER edge means nothing."""
    with pytest.raises(ValueError):
        resolve_range("all-30")


def test_a_range_says_itself_back_the_way_it_arrived():
    for age in ("0-3", "3-14", "0-all", "30-all"):
        assert format_range(resolve_range(age)) == age


def test_an_unbounded_range_gives_a_query_no_older_bound():
    now = datetime(2026, 8, 8, tzinfo=timezone.utc)
    assert range_cutoffs(resolve_range("0-all"), now) == (None, now)
    older, newer = range_cutoffs(resolve_range("3-14"), now)
    assert (older, newer) == (now - timedelta(days=14), now - timedelta(days=3))


def test_member_only_videos_are_excluded():
    """Gated content reports zero views but real likes — it would top like%
    and sit meaninglessly in every other order."""
    videos = [video("normal", views=100, likes=5), video("members", views=0, likes=500)]
    kept = filter_by_range(videos, *resolve_range("0-1"))
    assert [v.youtube_id for v in kept] == ["normal"]


def test_a_genuinely_unwatched_video_is_kept():
    """Zero views AND zero likes is a new upload, not gated content."""
    kept = filter_by_range([video("new", views=0, likes=0)], *resolve_range("0-1"))
    assert [v.youtube_id for v in kept] == ["new"]


# ── rank_videos ──────────────────────────────────────────────────────


def test_ranked_rows_carry_what_a_card_renders():
    names = {"chan1": "A Channel"}
    thumbs = {"chan1": "https://example.test/avatar.jpg"}
    (row,) = rank_videos([video("v1", views=1000)], names, "views", thumbs)
    assert row["youtube_id"] == "v1"
    assert row["channel_name"] == "A Channel"
    assert row["channel_thumbnail"] == "https://example.test/avatar.jpg"
    assert row["view_count"] == 1000
    assert row["is_short"] is False
    assert isinstance(row["published_at"], str)
    assert row["score"] > 0


def test_an_unknown_channel_gets_a_blank_name_not_a_crash():
    (row,) = rank_videos([video("v1")], {}, "views")
    assert row["channel_name"] == ""
    assert row["channel_thumbnail"] == ""


@pytest.mark.parametrize(
    "sort,expected",
    [
        ("views", ["most-views", "mid", "fewest-views"]),
        ("likes", ["most-likes", "mid", "fewest-likes"]),
    ],
)
def test_simple_sorts(sort, expected):
    videos = [
        video("mid", views=500, likes=50),
        video("most-views" if sort == "views" else "most-likes", views=900, likes=90),
        video("fewest-views" if sort == "views" else "fewest-likes", views=100, likes=10),
    ]
    ordered = [r["youtube_id"] for r in rank_videos(videos, {}, sort)]
    assert ordered == expected


def test_newest_and_oldest_are_mirror_images():
    videos = [video("a", hours_ago=1), video("b", hours_ago=5), video("c", hours_ago=3)]
    newest = [r["youtube_id"] for r in rank_videos(videos, {}, "newest")]
    oldest = [r["youtube_id"] for r in rank_videos(videos, {}, "oldest")]
    assert newest == ["a", "c", "b"]
    assert oldest == list(reversed(newest))


def test_unknown_sort_falls_back_to_the_hot_score():
    videos = [video("old-hit", hours_ago=20, views=5000), video("new-hit", hours_ago=1, views=3000)]
    ordered = [r["youtube_id"] for r in rank_videos(videos, {}, "nonsense")]
    by_score = [r["youtube_id"] for r in rank_videos(videos, {}, "score")]
    assert ordered == by_score


def test_like_pct_does_not_let_a_tiny_sample_top_the_list():
    """A video with 10 views and 9 likes has a 90% like rate and would win a raw
    sort outright. Against a normal field it has to land mid-pack instead."""
    # Like rates spread across 2–6%, as a real feed's are — a field where every
    # video sits exactly on the average is the one case with no headroom above it.
    field = [
        video(f"real{i}", views=views, likes=int(views * (0.02 + i * 0.002)))
        for i in range(20)
        for views in (100_000 + i * 10_000,)
    ]
    ordered = [
        r["youtube_id"]
        for r in rank_videos(field + [video("tiny", views=10, likes=9)],
                             {}, "like%")
    ]
    assert ordered[0] != "tiny"
    assert 0 < ordered.index("tiny") < len(ordered) - 1


def test_like_pct_collapses_a_tiny_sample_almost_all_the_way_to_the_prior():
    """The mechanism behind the test above: with 10 views against a 1500
    pseudo-view constant, essentially none of the raw ratio survives."""
    videos = [video("tiny", views=10, likes=9), video("real", views=200_000, likes=16_000)]
    ranked = rank_videos(videos, {}, "like%")
    prior = (9 + 16_000) / (10 + 200_000)
    shrunk = (9 + prior * LIKE_PCT_PSEUDO_VIEWS) / (10 + LIKE_PCT_PSEUDO_VIEWS)
    assert shrunk == pytest.approx(prior, abs=0.006)  # 0.90 raw → within 0.6pp of 0.08
    # It does still edge ahead of the single video that set the prior — with a
    # field of two there is nothing else for it to be pulled toward.
    assert [r["youtube_id"] for r in ranked] == ["tiny", "real"]


def test_like_pct_still_favours_a_genuinely_better_ratio_at_scale():
    """Shrinkage must not just re-sort by views: two videos with plenty of
    views each are trusted at close to their raw ratio."""
    videos = [
        video("engaging", views=100_000, likes=10_000),  # 10%
        video("popular", views=400_000, likes=12_000),   # 3%
    ]
    ordered = [r["youtube_id"] for r in rank_videos(videos, {}, "like%")]
    assert ordered == ["engaging", "popular"]


def test_like_pct_prior_is_the_fields_own_average():
    """The prior is computed from the result set, so a low-engagement field
    doesn't get judged against a high-engagement one."""
    videos = [video("a", views=1000, likes=100), video("b", views=1000, likes=50)]
    ranked = rank_videos(videos, {}, "like%")
    prior = 150 / 2000
    c = LIKE_PCT_PSEUDO_VIEWS
    expected = sorted(
        [("a", (100 + prior * c) / (1000 + c)), ("b", (50 + prior * c) / (1000 + c))],
        key=lambda x: -x[1],
    )
    assert [r["youtube_id"] for r in ranked] == [e[0] for e in expected]


def test_like_pct_with_no_views_at_all_uses_the_fallback_prior():
    """Every video at zero views would divide by zero deriving the prior."""
    videos = [video("a", views=0, likes=0), video("b", views=0, likes=0)]
    ranked = rank_videos(videos, {}, "like%")
    assert len(ranked) == 2
    assert LIKE_PCT_FALLBACK_PRIOR > 0


def test_ranking_an_empty_set_is_empty():
    assert rank_videos([], {}, "views") == []


def test_the_window_filter_applies_before_the_sort():
    videos = [video("recent", hours_ago=2, views=10), video("ancient", hours_ago=24 * 40, views=10_000)]
    ordered = [r["youtube_id"] for r in rank_videos(videos, {}, "views")]
    assert ordered == ["recent"]
