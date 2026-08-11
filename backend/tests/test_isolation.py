"""Two people, one app: what each of them can see.

The point of the whole accounts exercise. Every personal table gets the same
question asked of it through the real API — write as one person, read as the
other — because the failure this guards against isn't an exception, it's a quiet
one: a missing `WHERE user_id` returns somebody else's rows and looks fine.

Each pair authenticates by API key, which needs no session and names its owner
exactly. The transitional sole-account fallback (`auth.user_or_sole`) is out of
the way here by construction: there are always two.
"""

from datetime import datetime

import pytest
from sqlalchemy import select

from app import users
from app.models import Channel, User, Video, WatchHistory

pytestmark = pytest.mark.no_seeded_user


@pytest.fixture
async def pair(db):
    """Two accounts, and the headers that speak as each."""
    me = await users.ensure_local_user(db)
    them = User(google_sub="sub-2", email="them@example.test",
                api_key=users.new_api_key())
    db.add(them)
    await db.commit()
    return (
        {"Authorization": f"Bearer {me.api_key}"},
        {"Authorization": f"Bearer {them.api_key}"},
        me,
        them,
    )


# ── Watch history ────────────────────────────────────────────────────


async def test_history_is_not_shared(client, pair):
    mine, theirs, *_ = pair
    await client.post("/api/history", headers=mine, json={
        "youtube_id": "vid1", "position_seconds": 100.0,
        "duration_seconds": 600, "title": "A Video",
    })

    assert len((await client.get("/api/history", headers=mine)).json()) == 1
    assert (await client.get("/api/history", headers=theirs)).json() == []
    assert (await client.get("/api/history/vid1", headers=theirs)).json() == {}


async def test_the_same_video_holds_two_positions(client, pair):
    """One row each, not one row fought over — resuming has to follow the person
    watching, not whoever last touched the video."""
    mine, theirs, *_ = pair
    for headers, position in ((mine, 100.0), (theirs, 400.0)):
        await client.post("/api/history", headers=headers, json={
            "youtube_id": "vid1", "position_seconds": position,
            "duration_seconds": 600, "title": "A Video",
        })

    assert (await client.get("/api/history/vid1", headers=mine)
            ).json()["position_seconds"] == 100.0
    assert (await client.get("/api/history/vid1", headers=theirs)
            ).json()["position_seconds"] == 400.0


async def test_finishing_a_video_does_not_finish_it_for_anyone_else(client, pair):
    mine, theirs, *_ = pair
    await client.post("/api/history", headers=mine, json={
        "youtube_id": "vid1", "position_seconds": 595.0, "duration_seconds": 600,
    })
    await client.post("/api/history", headers=theirs, json={
        "youtube_id": "vid1", "position_seconds": 30.0, "duration_seconds": 600,
    })

    assert (await client.get("/api/history/vid1", headers=mine)).json()["watched"] is True
    assert (await client.get("/api/history/vid1", headers=theirs)).json()["watched"] is False


async def test_deleting_history_reaches_only_your_own_row(client, pair, db):
    mine, theirs, *_ = pair
    for headers in (mine, theirs):
        await client.post("/api/history", headers=headers, json={
            "youtube_id": "vid1", "position_seconds": 100.0, "duration_seconds": 600,
        })

    assert (await client.delete("/api/history/vid1", headers=mine)).status_code == 200
    rows = (await db.execute(select(WatchHistory))).scalars().all()
    assert len(rows) == 1
    assert len((await client.get("/api/history", headers=theirs)).json()) == 1


# ── Watch later ──────────────────────────────────────────────────────


async def test_watch_later_is_not_shared(client, pair):
    mine, theirs, *_ = pair
    await client.post("/api/watch-later", headers=mine,
                      json={"youtube_id": "vid1", "title": "A Video"})

    assert len((await client.get("/api/watch-later", headers=mine)).json()) == 1
    assert (await client.get("/api/watch-later", headers=theirs)).json() == []


async def test_removing_from_watch_later_leaves_theirs(client, pair):
    mine, theirs, *_ = pair
    for headers in (mine, theirs):
        await client.post("/api/watch-later", headers=headers,
                          json={"youtube_id": "vid1", "title": "A Video"})

    await client.delete("/api/watch-later/vid1", headers=mine)
    assert (await client.get("/api/watch-later", headers=mine)).json() == []
    assert len((await client.get("/api/watch-later", headers=theirs)).json()) == 1


# ── Bookmarks ────────────────────────────────────────────────────────


async def test_bookmarks_are_not_shared(client, pair):
    mine, theirs, *_ = pair
    await client.post("/api/bookmarks", headers=mine,
                      json={"video_id": "vid1", "position_seconds": 30.0})

    assert len((await client.get("/api/bookmarks/vid1", headers=mine)).json()) == 1
    assert (await client.get("/api/bookmarks/vid1", headers=theirs)).json() == []


async def test_someone_elses_bookmark_cannot_be_deleted(client, pair):
    """404 rather than 403 — a refusal would confirm the id exists."""
    mine, theirs, *_ = pair
    made = (await client.post("/api/bookmarks", headers=mine,
                              json={"video_id": "vid1", "position_seconds": 30.0})).json()

    r = await client.delete(f"/api/bookmarks/id/{made['id']}", headers=theirs)
    assert r.status_code == 404
    assert len((await client.get("/api/bookmarks/vid1", headers=mine)).json()) == 1


# ── Hidden channels ──────────────────────────────────────────────────


async def test_hiding_a_channel_hides_it_for_you_alone(client, pair):
    mine, theirs, *_ = pair
    await client.post("/api/hidden-channels/chanA", headers=mine)

    assert (await client.get("/api/hidden-channels", headers=mine)
            ).json()["channel_ids"] == ["chanA"]
    assert (await client.get("/api/hidden-channels", headers=theirs)
            ).json()["channel_ids"] == []


# ── Playlists ────────────────────────────────────────────────────────


async def test_playlists_are_not_shared(client, pair):
    mine, theirs, *_ = pair
    await client.post("/api/playlists", headers=mine, json={"name": "Mine"})

    assert len((await client.get("/api/playlists", headers=mine)).json()) == 1
    assert (await client.get("/api/playlists", headers=theirs)).json() == []


async def test_someone_elses_playlist_is_not_found(client, pair):
    """`playlist_items` has no owner of its own, so every route naming a playlist
    id is the door — read, rename, delete, and both item routes."""
    mine, theirs, *_ = pair
    made = (await client.post("/api/playlists", headers=mine,
                              json={"name": "Mine"})).json()
    pid = made["id"]

    assert (await client.get(f"/api/playlists/{pid}", headers=theirs)).status_code == 404
    assert (await client.patch(f"/api/playlists/{pid}", headers=theirs,
                               json={"name": "Hijacked"})).status_code == 404
    assert (await client.delete(f"/api/playlists/{pid}", headers=theirs)).status_code == 404
    assert (await client.post(f"/api/playlists/{pid}/items", headers=theirs,
                              json={"youtube_id": "vid1"})).status_code == 404
    assert (await client.delete(f"/api/playlists/{pid}/items/vid1",
                                headers=theirs)).status_code == 404

    assert (await client.get(f"/api/playlists/{pid}", headers=mine)).json()["name"] == "Mine"


async def test_the_save_to_menu_only_sees_your_playlists(client, pair):
    mine, theirs, *_ = pair
    made = (await client.post("/api/playlists", headers=mine,
                              json={"name": "Mine"})).json()
    await client.post(f"/api/playlists/{made['id']}/items", headers=mine,
                      json={"youtube_id": "vid1", "title": "A Video"})

    assert (await client.get("/api/playlists/containing/vid1", headers=mine)
            ).json() == [made["id"]]
    assert (await client.get("/api/playlists/containing/vid1", headers=theirs)
            ).json() == []


# ── Channel tags ─────────────────────────────────────────────────────


@pytest.fixture
async def tagged_channel(db):
    db.add(Channel(youtube_id="chanA", title="A Channel"))
    await db.commit()


async def test_tags_are_one_persons_opinion(client, pair, tagged_channel):
    """Two people can file the same channel differently, and each sidebar is
    built from its owner's answer."""
    mine, theirs, *_ = pair
    await client.post("/api/tags/chanA/tag/coding", headers=mine)
    await client.post("/api/tags/chanA/tag/piano", headers=theirs)

    assert (await client.get("/api/tags/channels", headers=mine)
            ).json() == {"chanA": ["coding"]}
    assert (await client.get("/api/tags/channels", headers=theirs)
            ).json() == {"chanA": ["piano"]}


async def test_tag_counts_are_your_own(client, pair, tagged_channel):
    mine, theirs, *_ = pair
    await client.post("/api/tags/chanA/tag/coding", headers=mine)

    assert [t["name"] for t in (await client.get("/api/tags", headers=mine)).json()] \
        == ["coding"]
    assert (await client.get("/api/tags", headers=theirs)).json() == []


async def test_removing_a_tag_leaves_theirs_in_place(client, pair, tagged_channel):
    mine, theirs, *_ = pair
    for headers in (mine, theirs):
        await client.post("/api/tags/chanA/tag/coding", headers=headers)

    await client.delete("/api/tags/chanA/tag/coding", headers=mine)
    assert (await client.get("/api/tags/channels", headers=mine)).json() == {}
    assert (await client.get("/api/tags/channels", headers=theirs)
            ).json() == {"chanA": ["coding"]}


# ── Settings ─────────────────────────────────────────────────────────


async def test_a_personal_setting_is_personal(client, pair):
    mine, theirs, *_ = pair
    await client.put("/api/settings", headers=mine,
                     json={"values": {"youtube_history_sync": False}})

    assert (await client.get("/api/settings", headers=mine)
            ).json()["values"]["youtube_history_sync"] is False
    assert (await client.get("/api/settings", headers=theirs)
            ).json()["values"]["youtube_history_sync"] is True


async def test_a_shared_setting_is_shared(client, pair):
    """`archive_fill_enabled` spends a quota billed to one Cloud project, so it's
    deliberately NOT per person — the switch is the machine's."""
    mine, theirs, *_ = pair
    await client.put("/api/settings", headers=mine,
                     json={"values": {"archive_fill_enabled": True}})

    assert (await client.get("/api/settings", headers=theirs)
            ).json()["values"]["archive_fill_enabled"] is True


async def test_the_page_is_told_which_switches_are_everyones(client, pair):
    mine, *_ = pair
    spec = {s["key"]: s["scope"]
            for s in (await client.get("/api/settings", headers=mine)).json()["settings"]}
    assert spec == {"archive_fill_enabled": "app", "youtube_history_sync": "user"}


# ── The extension's endpoint ─────────────────────────────────────────


async def test_the_extension_writes_to_its_own_owners_history(client, pair, monkeypatch):
    """The API key is the only thing saying whose history a report belongs in."""
    from app.routers import imported as imported_mod

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: {
        "title": "A Video", "channel": "A Channel", "channel_id": "chan1",
        "view_count": 1000, "like_count": 10, "duration": 300,
        "upload_date": "20260102",
    })
    mine, theirs, *_ = pair

    await client.post("/api/history/by-id/openedAAAAA", headers=theirs,
                      json={"position_seconds": 100.0, "duration_seconds": 600})

    assert (await client.get("/api/history", headers=mine)).json() == []
    assert len((await client.get("/api/history", headers=theirs)).json()) == 1


async def test_the_extension_switch_is_read_from_its_owner(client, pair, monkeypatch):
    """One person turning the recording off must not stop the other's."""
    from app.routers import imported as imported_mod

    def unexpected(vid):
        raise AssertionError("resolved a video for a report we don't want")

    monkeypatch.setattr(imported_mod, "_extract", unexpected)
    mine, theirs, *_ = pair

    await client.put("/api/settings", headers=theirs,
                     json={"values": {"youtube_history_sync": False}})

    refused = await client.post("/api/history/by-id/openedAAAAA", headers=theirs,
                                json={"position_seconds": 100.0, "duration_seconds": 600})
    assert refused.json() == {"status": "off"}

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: {
        "title": "A Video", "channel": "A Channel", "channel_id": "chan1",
        "view_count": 1000, "like_count": 10, "duration": 300,
        "upload_date": "20260102",
    })
    ok = await client.post("/api/history/by-id/openedAAAAA", headers=mine,
                           json={"position_seconds": 100.0, "duration_seconds": 600})
    assert ok.json()["status"] == "ok"


# ── The feed itself ──────────────────────────────────────────────────
#
# The catalog is shared on purpose: a channel two people follow is one row, one
# fetch, one tagging bill. That only works if reading it asks who wants to know.


@pytest.fixture
async def two_libraries(db, pair):
    """A channel and a video each, held by one person apiece."""
    _, _, me, them = pair
    for cid in ("mine", "theirs"):
        db.add(Channel(youtube_id=cid, title=f"Channel {cid}"))
        # Published now, so the feed's default age window can't be what excludes
        # it — the thing under test is the channel filter, not the date one.
        db.add(Video(youtube_id=f"vid-{cid}", channel_id=cid, title=f"Video {cid}",
                     published_at=datetime.utcnow(), view_count=100))
    await db.commit()
    await users.hold(db, me, "mine")
    await users.hold(db, them, "theirs")
    await db.commit()


async def test_the_channels_page_lists_only_what_you_follow(client, pair, two_libraries):
    mine, theirs, *_ = pair
    assert [c["youtube_id"] for c in
            (await client.get("/api/channels", headers=mine)).json()] == ["mine"]
    assert [c["youtube_id"] for c in
            (await client.get("/api/channels", headers=theirs)).json()] == ["theirs"]


async def test_the_feed_holds_only_your_channels_videos(client, pair, two_libraries):
    mine, theirs, *_ = pair

    def ids(payload):
        return {v["youtube_id"] for g in payload["groups"] for v in g["videos"]}

    assert ids((await client.get("/api/feed", headers=mine)).json()) == {"vid-mine"}
    assert ids((await client.get("/api/feed", headers=theirs)).json()) == {"vid-theirs"}


async def test_the_tag_feed_holds_only_your_channels_videos(client, pair, two_libraries):
    """The untagged branch used to be "every channel there is", which is the
    whole catalog rather than a library."""
    mine, theirs, *_ = pair
    r = (await client.get("/api/tags/feed", headers=mine)).json()
    assert {v["youtube_id"] for v in r["videos"]} == {"vid-mine"}


async def test_statistics_count_your_library_not_the_machines(client, pair, two_libraries):
    mine, *_ = pair
    assert (await client.get("/api/feed/statistics", headers=mine)).json() == {
        "channels": 1, "videos": 1,
    }


async def test_someone_following_nothing_sees_an_empty_feed(client, pair, two_libraries, db):
    """Not a fallback to everything — the case a missing filter would turn into
    "show the lot"."""
    _, _, me, _ = pair
    await users.release(db, me, ["mine"])
    await db.commit()

    mine = pair[0]
    assert (await client.get("/api/feed", headers=mine)).json()["groups"] == []
    assert (await client.get("/api/channels", headers=mine)).json() == []
    assert (await client.get("/api/feed/statistics", headers=mine)).json() == {
        "channels": 0, "videos": 0,
    }


# ── Imported videos ──────────────────────────────────────────────────


async def test_imports_are_not_shared(client, pair, monkeypatch):
    from app.routers import imported as imported_mod

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: {
        "title": "A Video", "channel": "A Channel", "channel_id": "chan1",
        "view_count": 1000, "like_count": 10, "duration": 300,
        "upload_date": "20260102",
    })
    mine, theirs, *_ = pair
    await client.post("/api/imported", headers=mine,
                      json={"urls": "https://youtu.be/importedAAA"})

    assert len((await client.get("/api/imported", headers=mine)).json()) == 1
    assert (await client.get("/api/imported", headers=theirs)).json() == []


async def test_the_second_person_to_paste_a_link_pays_no_fetch(client, pair, monkeypatch):
    """The snapshot is a cache and shared — one yt-dlp extraction however many
    people paste the same video — while the claim on it is per person."""
    from app.routers import imported as imported_mod

    calls = []

    def counted(vid):
        calls.append(vid)
        return {"title": "A Video", "channel": "A Channel", "channel_id": "chan1",
                "view_count": 1000, "like_count": 10, "duration": 300,
                "upload_date": "20260102"}

    monkeypatch.setattr(imported_mod, "_extract", counted)
    mine, theirs, *_ = pair

    await client.post("/api/imported", headers=mine,
                      json={"urls": "https://youtu.be/importedAAA"})
    res = (await client.post("/api/imported", headers=theirs,
                             json={"urls": "https://youtu.be/importedAAA"})).json()

    assert calls == ["importedAAA"]
    assert [v["youtube_id"] for v in res["added"]] == ["importedAAA"]
    assert len((await client.get("/api/imported", headers=theirs)).json()) == 1


async def test_removing_an_import_leaves_theirs_and_the_snapshot(client, pair, db, monkeypatch):
    from app.models import ImportedVideo
    from app.routers import imported as imported_mod

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: {
        "title": "A Video", "channel": "A Channel", "channel_id": "chan1",
        "view_count": 1000, "like_count": 10, "duration": 300,
        "upload_date": "20260102",
    })
    mine, theirs, *_ = pair
    for headers in (mine, theirs):
        await client.post("/api/imported", headers=headers,
                          json={"urls": "https://youtu.be/importedAAA"})

    await client.delete("/api/imported/importedAAA", headers=mine)

    assert (await client.get("/api/imported", headers=mine)).json() == []
    assert len((await client.get("/api/imported", headers=theirs)).json()) == 1
    # The watch page and history still read it for a title.
    assert await db.get(ImportedVideo, "importedAAA") is not None


# ── Search ───────────────────────────────────────────────────────────


async def test_search_is_narrowed_to_the_channels_you_follow(monkeypatch):
    """Meilisearch is shared catalog, so the filter is the only thing keeping
    one person's search out of another's library. Asserted on the filter this
    builds rather than through a live index, which the suite has no business
    starting."""
    from app import search_index

    seen = {}

    async def fake_raw(index, q, limit, offset=0, filter=None):
        seen[index] = filter
        return {"hits": [], "estimatedTotalHits": 0}

    monkeypatch.setattr(search_index, "_search_raw", fake_raw)
    await search_index.search("thing", channel_ids={"mine", "alsomine"})

    assert seen[search_index.VIDEOS_INDEX] == 'channel_id IN ["alsomine", "mine"]'
    assert seen[search_index.CHANNELS_INDEX] == 'youtube_id IN ["alsomine", "mine"]'


async def test_following_nothing_searches_nothing(monkeypatch):
    """An empty set must not fall through to an unfiltered query — that's the
    slip that would hand somebody the whole catalog."""
    from app import search_index

    async def unexpected(*a, **k):
        raise AssertionError("ran an unfiltered search")

    monkeypatch.setattr(search_index, "_search_raw", unexpected)
    assert await search_index.search("thing", channel_ids=set()) == {
        "channels": [], "videos": [], "videos_total": 0,
    }
