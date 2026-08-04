"""Bookmarks — the moments marked with `b` in the watch page."""


async def add(client, video_id: str, at: float, note: str = ""):
    r = await client.post(
        "/api/bookmarks",
        json={"video_id": video_id, "position_seconds": at, "note": note},
    )
    assert r.status_code == 200, r.text
    return r.json()


async def test_empty_video_has_no_bookmarks(client):
    r = await client.get("/api/bookmarks/never-marked")
    assert r.status_code == 200
    assert r.json() == []


async def test_add_returns_the_saved_row(client):
    b = await add(client, "vid1", 42.5, note="the good bit")
    assert b["video_id"] == "vid1"
    assert b["position_seconds"] == 42.5
    assert b["note"] == "the good bit"
    # An id the client can DELETE with, and a timestamp — both come from the DB,
    # so this also proves the row was flushed rather than just echoed back.
    assert isinstance(b["id"], int)
    assert b["created_at"]


async def test_listed_in_playback_order_not_insertion_order(client):
    """The list is stepped through with the video, so it's sorted by position."""
    await add(client, "vid1", 90)
    await add(client, "vid1", 10)
    await add(client, "vid1", 50)
    positions = [b["position_seconds"] for b in (await client.get("/api/bookmarks/vid1")).json()]
    assert positions == [10, 50, 90]


async def test_many_bookmarks_per_video(client):
    """Unlike watch history's single upserted row, marking twice keeps both."""
    await add(client, "vid1", 10)
    await add(client, "vid1", 10)
    assert len((await client.get("/api/bookmarks/vid1")).json()) == 2


async def test_bookmarks_are_scoped_to_their_video(client):
    await add(client, "vid1", 10)
    await add(client, "vid2", 20)
    assert len((await client.get("/api/bookmarks/vid1")).json()) == 1
    assert len((await client.get("/api/bookmarks/vid2")).json()) == 1


async def test_every_source_of_video_id_works(client):
    """One table covers YouTube ids, downloaded copies and local-folder hashes —
    the three id shapes the watch page can hand it. All are opaque here."""
    for vid in ("dQw4w9WgXcQ", "_yt-id_with-dashes", "a1b2c3d4e5f60718"):
        await add(client, vid, 5)
        assert len((await client.get(f"/api/bookmarks/{vid}")).json()) == 1


async def test_negative_position_is_clamped_to_zero(client):
    """A seek can report a fractionally negative time; a mark before the start
    would sort ahead of everything and seek nowhere."""
    b = await add(client, "vid1", -3.0)
    assert b["position_seconds"] == 0.0


async def test_note_is_trimmed(client):
    b = await add(client, "vid1", 5, note="  spaced  ")
    assert b["note"] == "spaced"


async def test_delete_removes_only_that_bookmark(client):
    keep = await add(client, "vid1", 10)
    drop = await add(client, "vid1", 20)
    r = await client.delete(f"/api/bookmarks/id/{drop['id']}")
    assert r.status_code == 200
    remaining = (await client.get("/api/bookmarks/vid1")).json()
    assert [b["id"] for b in remaining] == [keep["id"]]


async def test_delete_missing_bookmark_is_404(client):
    """Distinguishable from a successful delete, so the client can tell its
    optimistic removal from a stale id."""
    r = await client.delete("/api/bookmarks/id/9999")
    assert r.status_code == 404


async def test_delete_route_does_not_shadow_the_video_lookup(client):
    """`/id/{n}` and `/{video_id}` share a slot; a video literally called "id"
    must still list, not 404 as a bookmark."""
    await add(client, "id", 7)
    r = await client.get("/api/bookmarks/id")
    assert r.status_code == 200
    assert len(r.json()) == 1
