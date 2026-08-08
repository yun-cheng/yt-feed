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


# ── Saving with nothing but an id ────────────────────────────
#
# What the extension's button posts: it's on a YouTube page and knows the id
# only, so the metadata has to be resolved on this side.


def _info(**over):
    return {
        "title": "A Video", "channel": "A Channel", "channel_id": "chan1",
        "view_count": 1000, "like_count": 10, "duration": 300,
        "upload_date": "20260102", **over,
    }


async def _noop(records, db):
    """Avatars are the imported router's business and have their own tests."""


async def test_saving_by_id_fills_the_snapshot_in(client, monkeypatch):
    from app.routers import imported as imported_mod

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: _info())
    monkeypatch.setattr(imported_mod, "fill_channel_avatars", _noop)

    r = await client.post("/api/watch-later/by-id/openedAAAAA")
    assert r.json() == {"status": "ok", "saved": True, "already": False, "title": "A Video"}

    (row,) = (await client.get("/api/watch-later")).json()
    assert row["youtube_id"] == "openedAAAAA"
    assert (row["title"], row["channel_name"]) == ("A Video", "A Channel")
    assert (row["view_count"], row["duration_seconds"]) == (1000, 300)


async def test_a_video_we_already_hold_costs_no_extraction(client, db, monkeypatch):
    """A subscribed channel's video is already a row — saving it must not go to
    YouTube for what's sitting in the database."""
    from datetime import datetime

    from app.models import Channel, Video
    from app.routers import imported as imported_mod

    def unexpected(vid):
        raise AssertionError("went to YouTube for a video we already have")

    monkeypatch.setattr(imported_mod, "_extract", unexpected)

    db.add(Channel(youtube_id="chan1", title="A Channel"))
    db.add(Video(
        youtube_id="knownAAAAAA", channel_id="chan1", title="Known",
        published_at=datetime(2026, 1, 2), view_count=500, duration_seconds=120,
    ))
    await db.commit()

    r = await client.post("/api/watch-later/by-id/knownAAAAAA")
    assert r.json()["saved"] is True
    (row,) = (await client.get("/api/watch-later")).json()
    assert (row["title"], row["channel_name"]) == ("Known", "A Channel")


async def test_saving_the_same_id_twice_says_so(client, monkeypatch):
    """The button colours itself off this reply, and 'already saved' should read
    as success rather than as a failure to save."""
    from app.routers import imported as imported_mod

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: _info())
    monkeypatch.setattr(imported_mod, "fill_channel_avatars", _noop)

    await client.post("/api/watch-later/by-id/openedAAAAA")
    r = await client.post("/api/watch-later/by-id/openedAAAAA")
    assert r.json()["saved"] is True
    assert r.json()["already"] is True
    assert len((await client.get("/api/watch-later")).json()) == 1


async def test_a_video_that_cant_be_resolved_is_not_saved(client, monkeypatch):
    """Private, deleted or region-blocked. A row with no title renders as a
    blank card, so refuse it and let the button say the save failed."""
    from app.routers import imported as imported_mod

    def boom(vid):
        raise RuntimeError("Video unavailable")

    monkeypatch.setattr(imported_mod, "_extract", boom)

    r = await client.post("/api/watch-later/by-id/goneAAAAAAA")
    assert r.json() == {"status": "ok", "saved": False}
    assert (await client.get("/api/watch-later")).json() == []
