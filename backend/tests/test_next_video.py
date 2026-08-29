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

