"""The channel's next video forward in time — what the watch page offers at the end.

The interesting cases are all about ORDER: the suggestion walks a channel the way
it was published, so every test here is really asking "which row comes after this
one, and can the walk get stuck?".
"""

from datetime import datetime

import pytest

from app.models import Channel, Video


async def seed(db, channel_id: str, rows: list[tuple[str, str, bool]]):
    """rows: (video_id, published_at ISO, is_short)."""
    db.add(Channel(youtube_id=channel_id, title=f"Chan {channel_id}", thumbnail_url=""))
    for vid, when, short in rows:
        db.add(Video(
            youtube_id=vid,
            channel_id=channel_id,
            title=f"Video {vid}",
            thumbnail_url="",
            published_at=datetime.fromisoformat(when),
            duration_seconds=600,
            view_count=10,
            is_short=short,
        ))
    await db.commit()


@pytest.mark.asyncio
async def test_suggests_the_next_video_forward_in_time(client, db):
    await seed(db, "C1", [
        ("old", "2024-01-01T00:00:00", False),
        ("mid", "2024-02-01T00:00:00", False),
        ("new", "2024-03-01T00:00:00", False),
    ])
    body = (await client.get("/api/feed/next/old")).json()
    assert body["youtube_id"] == "mid"


@pytest.mark.asyncio
async def test_the_immediate_successor_not_the_newest(client, db):
    await seed(db, "C1", [
        ("a", "2024-01-01T00:00:00", False),
        ("b", "2024-02-01T00:00:00", False),
        ("c", "2024-03-01T00:00:00", False),
        ("d", "2024-04-01T00:00:00", False),
    ])
    body = (await client.get("/api/feed/next/b")).json()
    assert body["youtube_id"] == "c"


@pytest.mark.asyncio
async def test_the_newest_video_has_nothing_ahead(client, db):
    await seed(db, "C1", [
        ("old", "2024-01-01T00:00:00", False),
        ("new", "2024-03-01T00:00:00", False),
    ])
    assert (await client.get("/api/feed/next/new")).json() is None


@pytest.mark.asyncio
async def test_stays_on_the_same_channel(client, db):
    await seed(db, "C1", [("mine", "2024-01-01T00:00:00", False)])
    await seed(db, "C2", [("theirs", "2024-02-01T00:00:00", False)])
    assert (await client.get("/api/feed/next/mine")).json() is None


@pytest.mark.asyncio
async def test_shorts_and_long_form_are_separate_sequences(client, db):
    await seed(db, "C1", [
        ("essay", "2024-01-01T00:00:00", False),
        ("clip", "2024-02-01T00:00:00", True),
        ("essay2", "2024-03-01T00:00:00", False),
    ])
    assert (await client.get("/api/feed/next/essay")).json()["youtube_id"] == "essay2"


@pytest.mark.asyncio
async def test_a_short_leads_to_the_next_short(client, db):
    await seed(db, "C1", [
        ("clip1", "2024-01-01T00:00:00", True),
        ("essay", "2024-02-01T00:00:00", False),
        ("clip2", "2024-03-01T00:00:00", True),
    ])
    assert (await client.get("/api/feed/next/clip1")).json()["youtube_id"] == "clip2"


@pytest.mark.asyncio
async def test_videos_sharing_a_timestamp_stay_reachable(client, db):
    """Two rows published at the same instant. A bare `>` would make each skip
    the other, and the pair would be unreachable from the video before them."""
    await seed(db, "C1", [
        ("start", "2024-01-01T00:00:00", False),
        ("tie-a", "2024-02-01T00:00:00", False),
        ("tie-b", "2024-02-01T00:00:00", False),
        ("later", "2024-03-01T00:00:00", False),
    ])
    assert (await client.get("/api/feed/next/start")).json()["youtube_id"] == "tie-a"
    assert (await client.get("/api/feed/next/tie-a")).json()["youtube_id"] == "tie-b"
    assert (await client.get("/api/feed/next/tie-b")).json()["youtube_id"] == "later"


@pytest.mark.asyncio
async def test_an_unknown_video_suggests_nothing(client, db):
    await seed(db, "C1", [("only", "2024-01-01T00:00:00", False)])
    assert (await client.get("/api/feed/next/never-seen")).json() is None


@pytest.mark.asyncio
async def test_carries_the_channel_name_for_the_card(client, db):
    await seed(db, "C1", [
        ("old", "2024-01-01T00:00:00", False),
        ("new", "2024-02-01T00:00:00", False),
    ])
    body = (await client.get("/api/feed/next/old")).json()
    assert body["channel_name"] == "Chan C1"
    assert body["title"] == "Video new"
    assert body["duration_seconds"] == 600


# ── The channel page's filters, carried into the suggestion ────────────────
# Whatever narrowed the list you were browsing should narrow what comes next:
# the chain is meant to walk THAT list, not the whole channel.


async def label_videos(db, pairs: list[tuple[str, str | None]]):
    """Set title_labels on already-seeded rows. None = not labeled yet."""
    import json

    from sqlalchemy import select as _select

    for vid, labels in pairs:
        row = (await db.execute(_select(Video).where(Video.youtube_id == vid))).scalar_one()
        row.title_labels = None if labels is None else json.dumps([labels])
    await db.commit()


@pytest.mark.asyncio
async def test_a_topic_filter_skips_videos_without_it(client, db):
    await seed(db, "C1", [
        ("a", "2024-01-01T00:00:00", False),
        ("b", "2024-02-01T00:00:00", False),
        ("c", "2024-03-01T00:00:00", False),
    ])
    await label_videos(db, [("a", "rust"), ("b", "python"), ("c", "rust")])
    assert (await client.get("/api/feed/next/a?label=rust")).json()["youtube_id"] == "c"
    # Without the filter the very next one wins, topic or not.
    assert (await client.get("/api/feed/next/a")).json()["youtube_id"] == "b"


@pytest.mark.asyncio
async def test_a_topic_with_nothing_ahead_suggests_nothing(client, db):
    await seed(db, "C1", [
        ("a", "2024-01-01T00:00:00", False),
        ("b", "2024-02-01T00:00:00", False),
    ])
    await label_videos(db, [("a", "rust"), ("b", "python")])
    assert (await client.get("/api/feed/next/a?label=rust")).json() is None


@pytest.mark.asyncio
async def test_unwatched_filter_skips_what_you_have_seen(client, db):
    await seed(db, "C1", [
        ("a", "2024-01-01T00:00:00", False),
        ("b", "2024-02-01T00:00:00", False),
        ("c", "2024-03-01T00:00:00", False),
    ])
    await client.post("/api/history", json={
        "youtube_id": "b", "position_seconds": 590, "duration_seconds": 600,
    })
    assert (await client.get("/api/feed/next/a?watch=unwatched")).json()["youtube_id"] == "c"
    assert (await client.get("/api/feed/next/a")).json()["youtube_id"] == "b"


@pytest.mark.asyncio
async def test_every_status_kept_is_the_same_as_no_filter(client, db):
    await seed(db, "C1", [
        ("a", "2024-01-01T00:00:00", False),
        ("b", "2024-02-01T00:00:00", False),
    ])
    await client.post("/api/history", json={
        "youtube_id": "b", "position_seconds": 590, "duration_seconds": 600,
    })
    got = await client.get("/api/feed/next/a?watch=unwatched,in_progress,watched")
    assert got.json()["youtube_id"] == "b"


@pytest.mark.asyncio
async def test_the_window_caps_how_far_ahead_it_reaches(client, db):
    """A 3-14 day window has an upper edge, and the suggestion respects it — the
    video published yesterday isn't in the list you're looking at."""
    from datetime import timedelta

    now = datetime.utcnow()
    db.add(Channel(youtube_id="C1", title="Chan C1", thumbnail_url=""))
    for vid, days in (("old", 12), ("inside", 5), ("yesterday", 1)):
        db.add(Video(
            youtube_id=vid, channel_id="C1", title=vid, thumbnail_url="",
            published_at=now - timedelta(days=days), duration_seconds=600,
            view_count=10, is_short=False,
        ))
    await db.commit()
    assert (await client.get("/api/feed/next/old?age=3-14")).json()["youtube_id"] == "inside"
    assert (await client.get("/api/feed/next/inside?age=3-14")).json() is None
    # No window: the newest one ahead is fair game again.
    assert (await client.get("/api/feed/next/inside")).json()["youtube_id"] == "yesterday"


@pytest.mark.asyncio
async def test_filters_combine(client, db):
    await seed(db, "C1", [
        ("a", "2024-01-01T00:00:00", False),
        ("b", "2024-02-01T00:00:00", False),
        ("c", "2024-03-01T00:00:00", False),
        ("d", "2024-04-01T00:00:00", False),
    ])
    await label_videos(db, [("a", "rust"), ("b", "rust"), ("c", "python"), ("d", "rust")])
    await client.post("/api/history", json={
        "youtube_id": "b", "position_seconds": 590, "duration_seconds": 600,
    })
    body = (await client.get("/api/feed/next/a?label=rust&watch=unwatched")).json()
    assert body["youtube_id"] == "d"


@pytest.mark.asyncio
async def test_an_unlabeled_video_does_not_match_a_topic(client, db):
    """Labels are assigned lazily, so a video ahead may carry none yet. The
    channel page's own filter treats that as "not this topic"; so does this."""
    await seed(db, "C1", [
        ("a", "2024-01-01T00:00:00", False),
        ("b", "2024-02-01T00:00:00", False),
        ("c", "2024-03-01T00:00:00", False),
    ])
    await label_videos(db, [("a", "rust"), ("b", None), ("c", "rust")])
    assert (await client.get("/api/feed/next/a?label=rust")).json()["youtube_id"] == "c"


@pytest.mark.asyncio
async def test_a_broken_window_is_no_window(client, db):
    await seed(db, "C1", [
        ("a", "2024-01-01T00:00:00", False),
        ("b", "2024-02-01T00:00:00", False),
    ])
    assert (await client.get("/api/feed/next/a?age=nonsense")).json()["youtube_id"] == "b"
