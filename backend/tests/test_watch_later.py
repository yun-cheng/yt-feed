"""Watch Later — saved videos, server-side so they follow you between devices."""


async def save(client, youtube_id="vid1", **extra):
    r = await client.post("/api/watch-later", json={"youtube_id": youtube_id, **extra})
    assert r.status_code == 200, r.text
    return r.json()


async def test_starts_empty(client):
    assert (await client.get("/api/watch-later")).json() == []


async def test_saved_video_round_trips_its_snapshot(client):
    """The snapshot is what lets the card render after the video ages out of
    the feed window, so every field has to survive the round trip."""
    await save(
        client,
        title="A Video",
        channel_id="chan1",
        channel_name="A Channel",
        thumbnail_url="https://example.test/t.jpg",
        duration_seconds=300,
        published_at="2026-01-01T00:00:00",
        view_count=99,
        like_count=9,
        score=1.5,
    )
    (row,) = (await client.get("/api/watch-later")).json()
    assert row == {
        "youtube_id": "vid1",
        "title": "A Video",
        "channel_id": "chan1",
        "channel_name": "A Channel",
        "thumbnail_url": "https://example.test/t.jpg",
        "duration_seconds": 300,
        "published_at": "2026-01-01T00:00:00",
        "view_count": 99,
        "like_count": 9,
        "score": 1.5,
    }


async def test_saving_twice_is_a_no_op(client):
    await save(client, title="First")
    await save(client, title="Second")
    rows = (await client.get("/api/watch-later")).json()
    assert len(rows) == 1
    # The first save wins — re-saving doesn't refresh the snapshot.
    assert rows[0]["title"] == "First"


async def test_listed_most_recently_added_first(client):
    for vid in ("first", "second", "third"):
        await save(client, youtube_id=vid)
    ids = [r["youtube_id"] for r in (await client.get("/api/watch-later")).json()]
    assert ids[0] == "third"
    assert set(ids) == {"first", "second", "third"}


async def test_remove(client):
    await save(client, youtube_id="keep")
    await save(client, youtube_id="drop")
    assert (await client.delete("/api/watch-later/drop")).status_code == 200
    assert [r["youtube_id"] for r in (await client.get("/api/watch-later")).json()] == ["keep"]


async def test_removing_something_not_saved_is_not_an_error(client):
    assert (await client.delete("/api/watch-later/never-saved")).status_code == 200
