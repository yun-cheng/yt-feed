"""Playlists — user-created collections, with a metadata snapshot per item."""


async def make(client, name="Mine") -> int:
    r = await client.post("/api/playlists", json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def add(client, pid: int, youtube_id="vid1", **extra):
    r = await client.post(f"/api/playlists/{pid}/items", json={"youtube_id": youtube_id, **extra})
    assert r.status_code == 200, r.text
    return r.json()


async def test_starts_empty(client):
    assert (await client.get("/api/playlists")).json() == []


async def test_create_and_list(client):
    pid = await make(client, "Watch on the plane")
    (row,) = (await client.get("/api/playlists")).json()
    assert row["id"] == pid
    assert row["name"] == "Watch on the plane"
    assert row["item_count"] == 0
    assert row["thumbnail_url"] == ""


async def test_a_nameless_playlist_gets_a_default_name(client):
    """The create dialog can be submitted empty; a blank row in the sidebar
    would be unclickable."""
    pid = await make(client, "   ")
    assert (await client.get(f"/api/playlists/{pid}")).json()["name"] == "New playlist"


async def test_item_count_and_cover_come_from_the_items(client):
    pid = await make(client)
    await add(client, pid, "first", thumbnail_url="https://example.test/first.jpg")
    await add(client, pid, "second", thumbnail_url="https://example.test/second.jpg")
    (row,) = (await client.get("/api/playlists")).json()
    assert row["item_count"] == 2
    # The cover is the newest item, matching the order the page itself shows.
    assert row["thumbnail_url"] == "https://example.test/second.jpg"


async def test_items_are_newest_first(client):
    pid = await make(client)
    for vid in ("first", "second", "third"):
        await add(client, pid, vid)
    ids = [v["youtube_id"] for v in (await client.get(f"/api/playlists/{pid}")).json()["videos"]]
    assert ids[0] == "third"
    assert set(ids) == {"first", "second", "third"}


async def test_adding_the_same_video_twice_is_a_no_op(client):
    pid = await make(client)
    await add(client, pid, "vid1", title="First")
    await add(client, pid, "vid1", title="Second")
    videos = (await client.get(f"/api/playlists/{pid}")).json()["videos"]
    assert len(videos) == 1
    assert videos[0]["title"] == "First"


async def test_the_same_video_can_be_in_two_playlists(client):
    a, b = await make(client, "A"), await make(client, "B")
    await add(client, a, "vid1")
    await add(client, b, "vid1")
    assert len((await client.get(f"/api/playlists/{a}")).json()["videos"]) == 1
    assert len((await client.get(f"/api/playlists/{b}")).json()["videos"]) == 1


async def test_containing_powers_the_save_to_menu(client):
    a, b = await make(client, "A"), await make(client, "B")
    await add(client, a, "vid1")
    assert (await client.get("/api/playlists/containing/vid1")).json() == [a]
    await add(client, b, "vid1")
    assert sorted((await client.get("/api/playlists/containing/vid1")).json()) == sorted([a, b])
    assert (await client.get("/api/playlists/containing/other")).json() == []


async def test_remove_item(client):
    pid = await make(client)
    await add(client, pid, "keep")
    await add(client, pid, "drop")
    assert (await client.delete(f"/api/playlists/{pid}/items/drop")).status_code == 200
    videos = (await client.get(f"/api/playlists/{pid}")).json()["videos"]
    assert [v["youtube_id"] for v in videos] == ["keep"]


async def test_rename(client):
    pid = await make(client, "Old")
    r = await client.patch(f"/api/playlists/{pid}", json={"name": "New"})
    assert r.json() == {"id": pid, "name": "New"}
    assert (await client.get(f"/api/playlists/{pid}")).json()["name"] == "New"


async def test_renaming_to_blank_keeps_the_old_name(client):
    pid = await make(client, "Keep me")
    await client.patch(f"/api/playlists/{pid}", json={"name": "  "})
    assert (await client.get(f"/api/playlists/{pid}")).json()["name"] == "Keep me"


async def test_delete_takes_the_items_with_it(client):
    """Otherwise the rows outlive their playlist and `containing` keeps
    reporting a playlist the save-to menu can no longer show."""
    pid = await make(client)
    await add(client, pid, "vid1")
    assert (await client.delete(f"/api/playlists/{pid}")).status_code == 200
    assert (await client.get("/api/playlists")).json() == []
    assert (await client.get("/api/playlists/containing/vid1")).json() == []


async def test_deleting_one_playlist_leaves_the_others_intact(client):
    a, b = await make(client, "A"), await make(client, "B")
    await add(client, a, "vid1")
    await add(client, b, "vid2")
    await client.delete(f"/api/playlists/{a}")
    assert [v["youtube_id"] for v in (await client.get(f"/api/playlists/{b}")).json()["videos"]] == ["vid2"]


async def test_missing_playlist_is_404(client):
    assert (await client.get("/api/playlists/999")).status_code == 404
    assert (await client.patch("/api/playlists/999", json={"name": "x"})).status_code == 404
    assert (await client.post("/api/playlists/999/items", json={"youtube_id": "v"})).status_code == 404


# ── Adding with nothing but an id ────────────────────────────
#
# What the extension's save-to-playlist menu posts: it's on a YouTube page and
# knows the id only, so the metadata is resolved on this side.


def _info(**over):
    return {
        "title": "A Video", "channel": "A Channel", "channel_id": "chan1",
        "view_count": 1000, "like_count": 10, "duration": 300,
        "upload_date": "20260102", **over,
    }


async def _noop(records, db):
    """Avatars are the imported router's business and have their own tests."""


async def test_adding_by_id_fills_the_snapshot_in(client, monkeypatch):
    from app.routers import imported as imported_mod

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: _info())
    monkeypatch.setattr(imported_mod, "fill_channel_avatars", _noop)

    pid = await make(client)
    r = await client.post(f"/api/playlists/{pid}/items/by-id/openedAAAAA")
    assert r.json() == {"status": "ok", "saved": True, "already": False, "title": "A Video"}

    (row,) = (await client.get(f"/api/playlists/{pid}")).json()["videos"]
    assert row["youtube_id"] == "openedAAAAA"
    assert (row["title"], row["channel_name"]) == ("A Video", "A Channel")
    assert (row["view_count"], row["duration_seconds"]) == (1000, 300)


async def test_a_video_we_already_hold_costs_no_extraction(client, db, monkeypatch):
    """A video the feed already carries is a row here — adding it to a playlist
    must not go to YouTube for what's sitting in the database."""
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

    pid = await make(client)
    r = await client.post(f"/api/playlists/{pid}/items/by-id/knownAAAAAA")
    assert r.json()["saved"] is True
    (row,) = (await client.get(f"/api/playlists/{pid}")).json()["videos"]
    assert (row["title"], row["channel_name"]) == ("Known", "A Channel")


async def test_adding_the_same_id_twice_says_so(client, monkeypatch):
    """The menu ticks the row off this reply, and 'already there' should read as
    success rather than as a failure to add."""
    from app.routers import imported as imported_mod

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: _info())
    monkeypatch.setattr(imported_mod, "fill_channel_avatars", _noop)

    pid = await make(client)
    await client.post(f"/api/playlists/{pid}/items/by-id/openedAAAAA")
    r = await client.post(f"/api/playlists/{pid}/items/by-id/openedAAAAA")
    assert r.json()["saved"] is True
    assert r.json()["already"] is True
    assert len((await client.get(f"/api/playlists/{pid}")).json()["videos"]) == 1


async def test_a_video_that_cant_be_resolved_is_not_added(client, monkeypatch):
    """Private, deleted or region-blocked. A titleless row renders as a blank
    card, so refuse it and let the menu say the save failed."""
    from app.routers import imported as imported_mod

    def boom(vid):
        raise RuntimeError("Video unavailable")

    monkeypatch.setattr(imported_mod, "_extract", boom)

    pid = await make(client)
    r = await client.post(f"/api/playlists/{pid}/items/by-id/goneAAAAAAA")
    assert r.json() == {"status": "ok", "saved": False}
    assert (await client.get(f"/api/playlists/{pid}")).json()["videos"] == []


async def test_adding_by_id_to_someone_elses_playlist_is_404(
    client, db, seeded_user, monkeypatch
):
    """The id is the only thing the extension holds, so this route is the one a
    stolen key would reach for. Ownership is decided before anything is read."""
    from app import users
    from app.models import Playlist, User
    from app.routers import imported as imported_mod

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: _info())

    other = User(google_sub="sub-2", email="them@example.test", api_key=users.new_api_key())
    db.add(other)
    await db.flush()
    theirs = Playlist(user_id=other.id, name="Theirs")
    db.add(theirs)
    await db.commit()

    # Explicit key: with two accounts in the table there is no "sole user" for
    # an anonymous request to resolve to, and a 401 would prove nothing here.
    mine = {"Authorization": f"Bearer {seeded_user.api_key}"}
    r = await client.post(
        f"/api/playlists/{theirs.id}/items/by-id/openedAAAAA", headers=mine
    )
    assert r.status_code == 404
