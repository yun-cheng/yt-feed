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


# ── Saved loops ──────────────────────────────────────────────────────
#
# The other half of what the watch page marks on the play head. Many per video,
# like bookmarks — a video you're working through has several passages in it —
# but only one running at a time, which is what `active` carries.


async def add_loop(client, video_id: str, a=None, b=None, **kw):
    r = await client.post(f"/api/bookmarks/{video_id}/loops", json={"a": a, "b": b, **kw})
    assert r.status_code == 200, r.text
    return r.json()


async def loops(client, video_id: str):
    r = await client.get(f"/api/bookmarks/{video_id}/loops")
    assert r.status_code == 200
    return r.json()


async def test_a_video_never_looped_has_no_loops(client):
    """An empty list, not a 404: the page asks on every video it opens."""
    assert await loops(client, "never-looped") == []


async def test_a_loop_survives_leaving_the_video(client):
    await add_loop(client, "vid1", a=10.5, b=20.25)
    kept = (await loops(client, "vid1"))[0]
    assert (kept["a"], kept["b"]) == (10.5, 20.25)


async def test_several_passages_per_video(client):
    """The whole point: a video being worked through has more than one."""
    await add_loop(client, "vid1", a=10.0, b=20.0)
    await add_loop(client, "vid1", a=300.0, b=330.0)
    assert [(l["a"], l["b"]) for l in await loops(client, "vid1")] == [(10.0, 20.0), (300.0, 330.0)]


async def test_listed_in_the_order_they_were_marked(client):
    """Insertion order, not position order — unlike bookmarks, which are stepped
    through with the video. A loop list is a list of jobs."""
    await add_loop(client, "vid1", a=300.0, b=330.0)
    await add_loop(client, "vid1", a=10.0, b=20.0)
    assert [l["a"] for l in await loops(client, "vid1")] == [300.0, 10.0]


async def test_one_end_pinned_is_kept_as_it_is(client):
    """A half-set loop repeats — from the start of the video, or to the end of
    it — so it's a state worth storing, not a half-finished one to reject."""
    made = await add_loop(client, "vid1", a=90.0)
    assert (made["a"], made["b"]) == (90.0, None)


async def test_a_new_passage_becomes_the_running_one(client):
    """You only mark a passage when it's the one you're about to work on."""
    assert (await add_loop(client, "vid1", a=10.0, b=20.0))["active"] is True


async def test_only_one_passage_runs_at_a_time(client):
    """What makes a loop a mode rather than a mark."""
    first = await add_loop(client, "vid1", a=10.0, b=20.0)
    second = await add_loop(client, "vid1", a=300.0, b=330.0)

    by_id = {l["id"]: l["active"] for l in await loops(client, "vid1")}
    assert by_id == {first["id"]: False, second["id"]: True}


async def test_switching_back_moves_the_running_one(client):
    first = await add_loop(client, "vid1", a=10.0, b=20.0)
    await add_loop(client, "vid1", a=300.0, b=330.0)

    r = await client.patch(f"/api/bookmarks/vid1/loops/id/{first['id']}", json={"active": True})
    assert r.status_code == 200
    assert [l["active"] for l in await loops(client, "vid1")] == [True, False]


async def test_another_videos_loop_is_left_running(client):
    """Only one at a time *per video* — two videos are two pieces of work."""
    mine = await add_loop(client, "vid1", a=10.0, b=20.0)
    await add_loop(client, "vid2", a=10.0, b=20.0)
    assert (await loops(client, "vid1"))[0]["active"] is True
    assert mine["active"] is True


async def test_moving_an_end_leaves_the_rest_alone(client):
    """`[` on the running loop shouldn't have to restate that it's running."""
    made = await add_loop(client, "vid1", a=10.0, b=20.0)
    r = await client.patch(f"/api/bookmarks/vid1/loops/id/{made['id']}", json={"b": 30.0})
    assert r.json() == {"id": made["id"], "a": 10.0, "b": 30.0, "active": True}


async def test_an_end_can_be_unpinned_on_its_own(client):
    made = await add_loop(client, "vid1", a=10.0, b=20.0)
    r = await client.patch(f"/api/bookmarks/vid1/loops/id/{made['id']}", json={"b": None})
    assert (r.json()["a"], r.json()["b"]) == (10.0, None)


async def test_stopping_the_repeat_keeps_the_passage(client):
    """`\\` stops the repeat; it doesn't throw away the passage you marked."""
    made = await add_loop(client, "vid1", a=10.0, b=20.0)
    await client.patch(f"/api/bookmarks/vid1/loops/id/{made['id']}", json={"active": False})

    kept = await loops(client, "vid1")
    assert len(kept) == 1 and kept[0]["active"] is False


async def test_deleting_drops_only_that_passage(client):
    keep = await add_loop(client, "vid1", a=10.0, b=20.0)
    drop = await add_loop(client, "vid1", a=300.0, b=330.0)

    r = await client.delete(f"/api/bookmarks/vid1/loops/id/{drop['id']}")
    assert r.status_code == 200
    assert [l["id"] for l in await loops(client, "vid1")] == [keep["id"]]


async def test_deleting_promotes_nothing(client):
    """Which passage runs next is the page's call, and usually it's none."""
    made = await add_loop(client, "vid1", a=10.0, b=20.0)
    await add_loop(client, "vid1", a=300.0, b=330.0)
    await client.delete(f"/api/bookmarks/vid1/loops/id/{made['id']}")
    # The survivor was already the running one and stays that way; nothing was
    # activated to fill a gap.
    assert [l["active"] for l in await loops(client, "vid1")] == [True]


async def test_deleting_a_missing_loop_is_404(client):
    r = await client.delete("/api/bookmarks/vid1/loops/id/9999")
    assert r.status_code == 404


async def test_each_video_keeps_its_own_passages(client):
    await add_loop(client, "vid1", a=10.0, b=20.0)
    await add_loop(client, "vid2", a=300.0, b=330.0)
    assert [l["a"] for l in await loops(client, "vid1")] == [10.0]
    assert [l["a"] for l in await loops(client, "vid2")] == [300.0]


async def test_the_loops_route_does_not_shadow_the_bookmark_listing(client):
    """`/{video_id}` and `/{video_id}/loops` share a prefix; a video literally
    called "loops" must still list its bookmarks."""
    await add(client, "loops", 7)
    r = await client.get("/api/bookmarks/loops")
    assert r.status_code == 200
    assert len(r.json()) == 1
