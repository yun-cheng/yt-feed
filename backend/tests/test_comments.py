"""Turning yt-dlp's flat comment list into threads.

The nesting itself is a few lines; what's worth pinning down is everything
around it, because yt-dlp's field names promise more than they deliver.
`comment_count` is not the video's comment count, and the difference between
"comments are off" and "nobody has commented" is a `None` in one field.
"""

import pytest

from app.routers import feed
from app.routers.feed import COMMENT_PARENTS, _thread_comments


def c(cid, parent="root", **kw):
    """One comment in yt-dlp's shape."""
    return {
        "id": cid, "parent": parent, "text": kw.get("text", ""),
        "author": kw.get("author", "@someone"),
        "author_id": kw.get("author_id", "UC1"),
        "author_thumbnail": kw.get("thumb", "https://x/a.jpg"),
        "author_is_uploader": kw.get("uploader", False),
        "author_is_verified": kw.get("verified", False),
        "is_pinned": kw.get("pinned", False),
        "is_favorited": kw.get("hearted", False),
        "like_count": kw.get("likes", 0),
        "timestamp": kw.get("ts", 1_700_000_000),
        "_time_text": kw.get("time_text", "1 year ago"),
    }


def info(comments, count=None):
    return {"comments": comments, "comment_count": count}


# ── nesting ──────────────────────────────────────────────────────────


def test_replies_hang_off_the_comment_they_answer():
    out = _thread_comments(info([
        c("a"), c("a.1", parent="a"), c("a.2", parent="a"), c("b"),
    ], count=4))
    assert [t["id"] for t in out["threads"]] == ["a", "b"]
    assert [r["id"] for r in out["threads"][0]["replies"]] == ["a.1", "a.2"]
    assert out["threads"][1]["replies"] == []


def test_order_within_a_level_is_the_order_youtube_gave():
    """The sort we asked for is already applied — re-sorting here would quietly
    override "Newest first" with whatever field looked sort-worthy."""
    out = _thread_comments(info([
        c("a", likes=1), c("b", likes=999), c("c", likes=50),
    ], count=3))
    assert [t["id"] for t in out["threads"]] == ["a", "b", "c"]


def test_a_reply_whose_parent_is_missing_is_kept_at_the_top():
    """It can happen when the parent fell outside the fetch. Dropping it would
    be tidier and would make the list disagree with itself."""
    out = _thread_comments(info([c("a"), c("z.1", parent="z")], count=2))
    assert [t["id"] for t in out["threads"]] == ["a", "z.1"]


def test_a_reply_to_a_reply_nests_under_its_own_parent():
    out = _thread_comments(info([
        c("a"), c("a.1", parent="a"), c("a.1.1", parent="a.1"),
    ], count=3))
    replies = out["threads"][0]["replies"]
    assert [r["id"] for r in replies] == ["a.1"]
    assert [r["id"] for r in replies[0]["replies"]] == ["a.1.1"]


def test_no_comments_at_all_is_no_threads():
    out = _thread_comments(info([], count=0))
    assert out["threads"] == []


# ── the fields yt-dlp names badly ────────────────────────────────────


def test_comments_turned_off_is_not_the_same_as_no_comments():
    """yt-dlp answers a disabled section with `None` for both, and an empty one
    with `[]` and `0`. The panel says different things for each."""
    assert _thread_comments(info(None, count=None))["disabled"] is True
    assert _thread_comments(info([], count=0))["disabled"] is False


def test_a_section_that_returned_comments_is_never_reported_as_disabled():
    """Belt and braces: a video whose count is merely hidden still has comments,
    and must not be described as having them switched off."""
    out = _thread_comments(info([c("a")], count=None))
    assert out["disabled"] is False


def test_fetched_counts_what_we_got_including_replies():
    """Deliberately not called `total`: yt-dlp overwrites `comment_count` with
    the number extracted, which is our own cap rather than the video's total."""
    out = _thread_comments(info([c("a"), c("a.1", parent="a")], count=2))
    assert out["fetched"] == 2


def test_the_payload_says_when_it_stopped_at_our_cap():
    """So a truncated list can say "top 40" instead of reading as the whole of
    a quiet comment section."""
    full = _thread_comments(info([c(str(i)) for i in range(COMMENT_PARENTS)]))
    assert full["capped"] is True
    assert _thread_comments(info([c("a")]))["capped"] is False


def test_has_replies_distinguishes_the_two_walks():
    """The shallow walk can't say how many replies a thread has, so the panel
    offers one "load replies" for the lot — this is the flag it reads."""
    shallow = _thread_comments(info([c("a"), c("b")]))
    deep = _thread_comments(info([c("a"), c("a.1", parent="a")]))
    assert shallow["has_replies"] is False
    assert deep["has_replies"] is True


# ── what each comment carries ────────────────────────────────────────


def test_a_comment_carries_what_the_panel_draws():
    out = _thread_comments(info([c(
        "a", text="great at 1:30", author="@fan", author_id="UC9",
        likes=12, pinned=True, hearted=True, uploader=True, verified=True,
        time_text="2 days ago",
    )]))
    t = out["threads"][0]
    assert t["text"] == "great at 1:30"
    assert t["author"] == "@fan"
    assert t["author_id"] == "UC9"
    assert t["like_count"] == 12
    assert t["time_text"] == "2 days ago"
    assert t["is_pinned"] and t["author_is_uploader"] and t["author_is_verified"]
    # yt-dlp's name for the creator's heart is `is_favorited`, which reads like
    # something the viewer did. Renamed on the way out.
    assert t["hearted"] is True


def test_missing_fields_become_empty_rather_than_None():
    """A comment with nothing but an id still has to render."""
    t = _thread_comments(info([{"id": "a", "parent": "root"}]))["threads"][0]
    assert t["author"] == "" and t["text"] == "" and t["author_thumbnail"] == ""
    assert t["like_count"] == 0
    assert t["is_pinned"] is False and t["hearted"] is False


# ── the endpoint ─────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def no_yt_dlp(monkeypatch):
    """Stand in for the extraction, and record what was asked of it.

    Every test below is about the endpoint's own decisions — which arguments it
    passes on and when it goes out at all — so the one thing that must not
    happen is a real walk of YouTube.
    """
    calls: list[tuple[str, str, bool]] = []

    def fake(video_id, sort, replies):
        calls.append((video_id, sort, replies))
        return info([c("a", text=f"{sort}/{replies}")], count=1)

    monkeypatch.setattr(feed, "_extract_comments", fake)
    feed._cm_cache.clear()
    feed._cm_inflight.clear()
    return calls


@pytest.mark.asyncio
async def test_the_endpoint_returns_threads(client, no_yt_dlp):
    r = await client.get("/api/feed/comments/vid1")
    assert r.status_code == 200
    body = r.json()
    assert [t["text"] for t in body["threads"]] == ["top/False"]
    assert body["disabled"] is False


@pytest.mark.asyncio
async def test_an_unknown_sort_falls_back_to_top(client, no_yt_dlp):
    """The sort reaches yt-dlp's own configuration, so it's checked against a
    known set rather than passed through."""
    await client.get("/api/feed/comments/vid1?sort=; rm -rf")
    assert no_yt_dlp[0][1] == "top"


@pytest.mark.asyncio
async def test_newest_is_passed_through(client, no_yt_dlp):
    await client.get("/api/feed/comments/vid1?sort=new")
    assert no_yt_dlp[0][1] == "new"


@pytest.mark.asyncio
async def test_a_second_ask_is_served_from_the_cache(client, no_yt_dlp):
    """Reopening the panel, or a second tab on the same video, mustn't pay the
    walk again."""
    await client.get("/api/feed/comments/vid1")
    await client.get("/api/feed/comments/vid1")
    assert len(no_yt_dlp) == 1


@pytest.mark.asyncio
async def test_replies_are_a_separate_cache_entry(client, no_yt_dlp):
    """The shallow answer must not be handed back to someone who asked for the
    deep one — that's the whole "load replies" button quietly doing nothing."""
    await client.get("/api/feed/comments/vid1")
    await client.get("/api/feed/comments/vid1?replies=1")
    assert [call[2] for call in no_yt_dlp] == [False, True]


@pytest.mark.asyncio
async def test_each_sort_is_its_own_cache_entry(client, no_yt_dlp):
    await client.get("/api/feed/comments/vid1?sort=top")
    await client.get("/api/feed/comments/vid1?sort=new")
    assert [call[1] for call in no_yt_dlp] == ["top", "new"]


@pytest.mark.asyncio
async def test_a_failed_extraction_reads_as_an_empty_section(client, monkeypatch):
    """Not as a 500. The panel is an extra on a page that is otherwise fine."""
    def boom(video_id, sort, replies):
        raise RuntimeError("YouTube said no")

    monkeypatch.setattr(feed, "_extract_comments", boom)
    feed._cm_cache.clear()
    r = await client.get("/api/feed/comments/vid2")
    assert r.status_code == 200
    assert r.json() == {
        "disabled": False, "fetched": 0, "capped": False,
        "has_replies": False, "threads": [],
    }
