"""
Ranking engine — score = view_count / hours_since_published.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models import Video

# Hot-score "burn-in": hours added to a video's age before dividing views by it.
# Without it, a video published minutes ago divides by ~0.1h and a handful of
# views explodes to the top of the hot order. This shrinks early velocity toward
# 0 until enough time (and thus views) accrues to trust the rate.
HOT_HOUR_OFFSET = 12.0

# like% Bayesian shrinkage: a video's like/view ratio is pulled toward the feed's
# average, weighted by C "pseudo-views". Small-sample videos sit near the prior;
# only videos with >> C views are trusted at their raw ratio.
LIKE_PCT_PSEUDO_VIEWS = 1500
LIKE_PCT_FALLBACK_PRIOR = 0.04  # used when the result set has no views to average


def score_video(view_count: int, published_at: datetime) -> float:
    """Hot score = views / (hours since published + burn-in offset)."""
    now = datetime.now(timezone.utc)
    if published_at.tzinfo is None:
        published_at = published_at.replace(tzinfo=timezone.utc)
    hours = max((now - published_at).total_seconds() / 3600, 0.0)
    return view_count / (hours + HOT_HOUR_OFFSET)


# The ladder of day boundaries a window's edges may sit on. The UI's two-handled
# slider snaps to these, so every range that can arrive is one of the pairs the
# ladder allows.
TICK_DAYS = [0, 1, 3, 7, 14, 30, 90, 180, 365]

# The ladder's last rung is unbounded: "all" means "however far back we hold".
# It spells itself rather than picking a day count, because any finite stand-in
# would be a sentinel that reads as data everywhere it travels.
ALL_TOKEN = "all"

# What a request that names no window means: the past three days.
DEFAULT_AGE = "0-3"

# A resolved range: offsets back from now for the newer and older edges. The
# older edge is None when the range is unbounded.
DateRange = tuple[timedelta, "timedelta | None"]


def _nearest_tick(days: int) -> int:
    return min(TICK_DAYS, key=lambda t: abs(t - days))


def resolve_range(age: str | None = None) -> DateRange:
    """The (newer, older) offsets from now that a request's `age` means.

    "3-14" is "published 3 to 14 days ago"; "3-all" is "published more than 3
    days ago". Finite edges snap to TICK_DAYS, so a hand-edited URL still lands
    on the ladder the UI speaks.
    """
    if not age:
        age = DEFAULT_AGE
    try:
        lo_s, hi_s = age.split("-", 1)
        lo = _nearest_tick(int(lo_s))
        hi = None if hi_s.strip() == ALL_TOKEN else _nearest_tick(int(hi_s))
    except ValueError:
        raise ValueError(f"malformed age range: {age!r}") from None
    if hi is None:
        return timedelta(days=lo), None
    if lo > hi:
        lo, hi = hi, lo
    if lo == hi:
        raise ValueError(f"empty age range: {age!r}")
    return timedelta(days=lo), timedelta(days=hi)


def format_range(date_range: DateRange) -> str:
    """A resolved range back in the wire spelling, for a response to echo."""
    newer, older = date_range
    return f"{newer.days}-{ALL_TOKEN if older is None else older.days}"


def range_cutoffs(date_range: DateRange, now: datetime | None = None) -> tuple[datetime | None, datetime]:
    """A range as absolute (older, newer) datetimes, for a SQL WHERE clause.

    The older bound is None when the range is unbounded — a query should then
    omit its lower comparison rather than invent a floor.
    """
    now = now or datetime.now(timezone.utc)
    newer_offset, older_offset = date_range
    return (None if older_offset is None else now - older_offset), now - newer_offset


def filter_by_range(videos: list[Video], lower_offset: timedelta, upper_offset: timedelta | None) -> list[Video]:
    """Filter videos to publish times between two offsets back from now.

    `upper_offset=None` leaves the range open at the older end.
    """
    lower, upper = range_cutoffs((lower_offset, upper_offset))

    result = []
    for v in videos:
        # Exclude member-only videos (0 views but has likes — gated content)
        if v.view_count == 0 and v.like_count > 0:
            continue
        pub = v.published_at
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)
        if pub < upper and (lower is None or lower <= pub):
            result.append(v)
    return result


def rank_videos(videos: list[Video], channel_names: dict[str, str] | None = None, sort: str = "likes", channel_thumbnails: dict[str, str] | None = None, date_range: DateRange | None = None) -> list[dict]:
    """
    Rank videos filtered by time window, sorted by the given criteria.

    Sort modes:
      score   — view_count / hours_since_published (default)
      views   — view_count descending
      likes   — like_count descending
      like%   — like_count / view_count (engagement rate)
      newest  — published_at descending
      oldest  — published_at ascending

    Returns list of dicts with score included.
    channel_names: optional dict of channel_id → channel_title.
    date_range: a resolved (newer, older) pair; omitted means DEFAULT_AGE.
    """
    if date_range is None:
        date_range = resolve_range()
    filtered = filter_by_range(videos, *date_range)
    ranked = []
    for v in filtered:
        ranked.append({
            "youtube_id": v.youtube_id,
            "title": v.title,
            "channel_id": v.channel_id,
            "channel_name": (channel_names or {}).get(v.channel_id, ""),
            "channel_thumbnail": (channel_thumbnails or {}).get(v.channel_id, ""),
            "thumbnail_url": v.thumbnail_url,
            "published_at": v.published_at.isoformat(),
            "view_count": v.view_count,
            "like_count": v.like_count,
            "duration_seconds": v.duration_seconds,
            "is_short": bool(v.is_short),
            "score": round(score_video(v.view_count, v.published_at), 2),
        })

    if sort == "views":
        ranked.sort(key=lambda x: x["view_count"], reverse=True)
    elif sort == "likes":
        ranked.sort(key=lambda x: x["like_count"], reverse=True)
    elif sort == "like%":
        # Shrink each ratio toward the feed's average like/view rate so tiny-sample
        # videos can't top the list on a handful of likes (see LIKE_PCT_* above).
        total_likes = sum(x["like_count"] for x in ranked)
        total_views = sum(x["view_count"] for x in ranked)
        prior = total_likes / total_views if total_views else LIKE_PCT_FALLBACK_PRIOR
        c = LIKE_PCT_PSEUDO_VIEWS
        ranked.sort(
            key=lambda x: (x["like_count"] + prior * c) / (x["view_count"] + c),
            reverse=True,
        )
    elif sort == "newest":
        ranked.sort(key=lambda x: x["published_at"], reverse=True)
    elif sort == "oldest":
        ranked.sort(key=lambda x: x["published_at"])
    else:  # score (default)
        ranked.sort(key=lambda x: x["score"], reverse=True)

    return ranked