"""Importing playlists from YouTube — over the Data API, and via the extension.

The API path is stubbed at `youtube_api`'s two fetchers rather than at httpx:
what these tests are about is the merge, the linking and the guards, and a stub
that returns the shape those functions promise is the smallest thing that
exercises all three.
"""

import pytest

from app import youtube_api
from app.routers import playlists as playlists_router


@pytest.fixture(autouse=True)
def no_enrichment(monkeypatch):
    """Keep `batch_fetch_video_stats` away from the network by default.

    Every import calls it to fill in durations and view counts. Left alone it
    would try to load a token that isn't there — which degrades quietly rather
    than failing, but does so by printing, and one test below wants to assert
    what enrichment actually does.
    """
    monkeypatch.setattr(youtube_api, "batch_fetch_video_stats", lambda ids: {})


def fake_items(*ids, **extra):
    return [
        {
            "youtube_id": i,
            "title": f"Video {i}",
            "channel_id": "UC" + "x" * 22,
            "channel_name": "Someone",
            "thumbnail_url": f"https://example.test/{i}.jpg",
            "published_at": "2024-01-01T00:00:00Z",
            **extra,
        }
        for i in ids
    ]


def stub_api(monkeypatch, playlists=None, items=None, details=None):
    monkeypatch.setattr(
        youtube_api, "fetch_my_playlists", lambda: playlists or []
    )
    monkeypatch.setattr(
        youtube_api, "fetch_playlist_items", lambda pid, limit=5_000: items or []
    )
    monkeypatch.setattr(
        youtube_api, "fetch_playlist_details", lambda pid: details
    )


# --- naming a playlist by link ----------------------------------------------


@pytest.mark.parametrize("text,expected", [
    ("PLabc123", "PLabc123"),
    ("https://www.youtube.com/playlist?list=PLabc123", "PLabc123"),
    # A watch URL that carries one: "the playlist this video is in" is a fair
    # reading of pasting it, and refusing a link containing the answer is worse.
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123&index=2", "PLabc123"),
    ("https://m.youtube.com/playlist?list=OLAK5uy_abc", "OLAK5uy_abc"),
    ("WL", "WL"),
    ("  PLabc123  ", "PLabc123"),
    # Nothing that names a playlist.
    ("", ""),
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", ""),
    ("not a playlist!", ""),
    ("https://www.youtube.com/playlist?list=has spaces", ""),
])
def test_playlist_ref_parsing(text, expected):
    assert playlists_router.playlist_ref(text) == expected


# --- listing ----------------------------------------------------------------


async def test_lists_the_accounts_youtube_playlists(client, monkeypatch):
    stub_api(monkeypatch, playlists=[
        {"youtube_id": "PL1", "title": "Cooking", "description": "",
         "thumbnail_url": "https://example.test/c.jpg", "item_count": 12},
    ])
    rows = (await client.get("/api/playlists/youtube")).json()
    assert [r["title"] for r in rows] == ["Cooking"]
    # Nothing imported yet, so nothing is linked.
    assert rows[0]["linked_id"] is None


async def test_an_imported_playlist_is_marked_linked(client, monkeypatch):
    """What turns a second click into "Re-sync" instead of a duplicate."""
    stub_api(
        monkeypatch,
        playlists=[{"youtube_id": "PL1", "title": "Cooking", "description": "",
                    "thumbnail_url": "", "item_count": 1}],
        items=fake_items("a"),
    )
    imported = (await client.post(
        "/api/playlists/import", json={"youtube_id": "PL1", "name": "Cooking"}
    )).json()

    rows = (await client.get("/api/playlists/youtube")).json()
    assert rows[0]["linked_id"] == imported["id"]


async def test_lookup_finds_a_playlist_someone_else_owns(client, monkeypatch):
    """The hole `/youtube` can't fill. YouTube offers no way to enumerate the
    playlists you saved from other people — but `playlists.list?id=` reads any
    public one, so a playlist that can't be listed can still be named."""
    stub_api(monkeypatch, details={
        "youtube_id": "PLtheirs", "title": "Their mix", "description": "",
        "thumbnail_url": "https://example.test/t.jpg", "item_count": 9,
        "channel_id": "UC" + "y" * 22, "channel_name": "Somebody Else",
    })
    res = await client.get(
        "/api/playlists/youtube/lookup",
        params={"ref": "https://www.youtube.com/playlist?list=PLtheirs"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["title"] == "Their mix"
    assert body["channel_name"] == "Somebody Else"
    assert body["linked_id"] is None


async def test_lookup_reports_an_already_imported_playlist(client, monkeypatch):
    stub_api(
        monkeypatch,
        items=fake_items("a"),
        details={"youtube_id": "PLtheirs", "title": "Their mix", "description": "",
                 "thumbnail_url": "", "item_count": 1, "channel_id": "",
                 "channel_name": "Somebody Else"},
    )
    imported = (await client.post(
        "/api/playlists/import", json={"youtube_id": "PLtheirs"}
    )).json()

    body = (await client.get(
        "/api/playlists/youtube/lookup", params={"ref": "PLtheirs"}
    )).json()
    assert body["linked_id"] == imported["id"]


async def test_lookup_rejects_something_that_isnt_a_playlist(client, monkeypatch):
    stub_api(monkeypatch)
    res = await client.get(
        "/api/playlists/youtube/lookup",
        params={"ref": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
    )
    assert res.status_code == 400


async def test_lookup_of_a_private_playlist_points_at_the_extension(client, monkeypatch):
    """`playlists.list?id=` sees public playlists only. Someone else's private
    one is exactly what the extension exists for."""
    stub_api(monkeypatch, details=None)
    res = await client.get("/api/playlists/youtube/lookup", params={"ref": "PLnope"})
    assert res.status_code == 404
    assert "extension" in res.json()["detail"]


async def test_lookup_is_owner_only(client, db, monkeypatch):
    from app.models import User
    from app.users import new_api_key

    second = User(email="them@example.test", api_key=new_api_key())
    db.add(second)
    await db.commit()
    await db.refresh(second)

    stub_api(monkeypatch, details={"youtube_id": "PL1", "title": "x", "description": "",
                                   "thumbnail_url": "", "item_count": 1,
                                   "channel_id": "", "channel_name": ""})
    res = await client.get(
        "/api/playlists/youtube/lookup", params={"ref": "PL1"},
        headers={"Authorization": f"Bearer {second.api_key}"},
    )
    assert res.status_code == 400


async def test_import_accepts_a_pasted_link(client, monkeypatch):
    """So the lookup can hand its answer straight back, and a caller holding
    only a URL needn't parse it."""
    stub_api(monkeypatch, items=fake_items("a", "b"))
    res = await client.post("/api/playlists/import", json={
        "youtube_id": "https://www.youtube.com/playlist?list=PLtheirs",
        "name": "Their mix",
    })
    assert res.status_code == 200, res.text
    assert res.json()["added"] == 2
    detail = (await client.get(f"/api/playlists/{res.json()['id']}")).json()
    assert detail["youtube_id"] == "PLtheirs"  # the id, not the URL


# --- importing --------------------------------------------------------------


async def test_import_copies_the_videos_and_remembers_the_source(client, monkeypatch):
    stub_api(monkeypatch, items=fake_items("a", "b", "c"))
    res = await client.post(
        "/api/playlists/import", json={"youtube_id": "PL1", "name": "Cooking"}
    )
    assert res.status_code == 200, res.text
    assert res.json()["added"] == 3

    detail = (await client.get(f"/api/playlists/{res.json()['id']}")).json()
    assert detail["name"] == "Cooking"
    assert detail["youtube_id"] == "PL1"
    assert detail["synced_at"] is not None
    assert {v["youtube_id"] for v in detail["videos"]} == {"a", "b", "c"}


async def test_import_preserves_playlist_order(client, monkeypatch):
    """YouTube's order is deliberate, and the detail page sorts newest-first —
    so the importer spaces `added_at` to reproduce it rather than lose it."""
    stub_api(monkeypatch, items=fake_items("first", "second", "third"))
    res = await client.post("/api/playlists/import", json={"youtube_id": "PL1"})
    detail = (await client.get(f"/api/playlists/{res.json()['id']}")).json()
    assert [v["youtube_id"] for v in detail["videos"]] == ["first", "second", "third"]


async def test_importing_twice_resyncs_rather_than_duplicating(client, monkeypatch):
    stub_api(monkeypatch, items=fake_items("a", "b"))
    first = (await client.post("/api/playlists/import", json={"youtube_id": "PL1"})).json()

    stub_api(monkeypatch, items=fake_items("a", "b", "c"))
    second = (await client.post("/api/playlists/import", json={"youtube_id": "PL1"})).json()

    assert second["id"] == first["id"]
    assert second["added"] == 1
    assert len((await client.get("/api/playlists")).json()) == 1


async def test_import_needs_a_playlist_id(client, monkeypatch):
    stub_api(monkeypatch)
    assert (await client.post("/api/playlists/import", json={"youtube_id": "  "})).status_code == 400


async def test_import_says_so_when_youtube_returns_nothing(client, monkeypatch):
    """Two real causes, one empty answer: the API declining (Watch Later), and a
    playlist whose every entry is private or deleted — both seen in practice. A
    silently-created empty playlist would be a puzzle either way."""
    stub_api(monkeypatch, items=[])
    res = await client.post("/api/playlists/import", json={"youtube_id": "WL"})
    assert res.status_code == 404
    assert "extension" in res.json()["detail"]
    assert (await client.get("/api/playlists")).json() == []


async def test_nothing_is_written_before_youtube_answers(client, monkeypatch):
    """Order of operations, and it is load-bearing twice over.

    Creating the playlist row first would hold SQLite's single write lock while
    `quota.record` — which uses a session of its own — tried to update the
    ledger, and the import would die with "database is locked". It would also
    leave an empty playlist behind every time a read failed.

    So: assert the read happens while the playlists table is still untouched.
    """
    import os
    import sqlite3

    seen = {}

    def spy(pid, limit=5_000):
        # Read through a connection of our own, which is what makes this a real
        # test of the deadlock and not just of ordering: `quota.record` uses a
        # separate session too, and a held write lock is what it collides with.
        conn = sqlite3.connect(os.environ["DB_PATH"], timeout=2)
        try:
            seen["rows"] = conn.execute("SELECT COUNT(*) FROM playlists").fetchone()[0]
        finally:
            conn.close()
        return fake_items("a", "b")

    monkeypatch.setattr(youtube_api, "fetch_playlist_items", spy)

    res = await client.post("/api/playlists/import", json={"youtube_id": "PL1"})
    assert res.status_code == 200, res.text
    assert seen["rows"] == 0, "the playlist was created before YouTube was asked"
    assert len((await client.get("/api/playlists")).json()) == 1


async def test_a_failed_read_leaves_no_empty_playlist(client, monkeypatch):
    """The visible half of the ordering above."""
    def boom(pid, limit=5_000):
        raise youtube_api.QuotaExceeded("no allowance left")

    monkeypatch.setattr(youtube_api, "fetch_playlist_items", boom)
    assert (await client.post(
        "/api/playlists/import", json={"youtube_id": "PL1"}
    )).status_code == 429
    assert (await client.get("/api/playlists")).json() == []


async def test_a_spent_quota_is_a_429(client, monkeypatch):
    def boom(pid, limit=5_000):
        raise youtube_api.QuotaExceeded("no allowance left")

    monkeypatch.setattr(youtube_api, "fetch_playlist_items", boom)
    res = await client.post("/api/playlists/import", json={"youtube_id": "PL1"})
    assert res.status_code == 429
    assert "midnight Pacific" in res.json()["detail"]


# --- re-syncing -------------------------------------------------------------


async def test_resync_adds_only_what_is_new(client, monkeypatch):
    stub_api(monkeypatch, items=fake_items("a"))
    pid = (await client.post("/api/playlists/import", json={"youtube_id": "PL1"})).json()["id"]

    stub_api(monkeypatch, items=fake_items("a", "b"))
    res = await client.post(f"/api/playlists/{pid}/resync")
    assert res.json()["added"] == 1
    detail = (await client.get(f"/api/playlists/{pid}")).json()
    assert {v["youtube_id"] for v in detail["videos"]} == {"a", "b"}


async def test_resync_never_removes_what_youtube_dropped(client, monkeypatch):
    """The whole reason re-sync is safe to click. A video pulled from the
    YouTube playlist stays in your copy — this is an import, not a mirror."""
    stub_api(monkeypatch, items=fake_items("a", "b"))
    pid = (await client.post("/api/playlists/import", json={"youtube_id": "PL1"})).json()["id"]

    stub_api(monkeypatch, items=fake_items("a"))
    await client.post(f"/api/playlists/{pid}/resync")

    detail = (await client.get(f"/api/playlists/{pid}")).json()
    assert {v["youtube_id"] for v in detail["videos"]} == {"a", "b"}


async def test_resync_refuses_a_playlist_made_here(client, monkeypatch):
    stub_api(monkeypatch, items=fake_items("a"))
    pid = (await client.post("/api/playlists", json={"name": "Mine"})).json()["id"]
    res = await client.post(f"/api/playlists/{pid}/resync")
    assert res.status_code == 400
    assert "wasn't imported" in res.json()["detail"]


async def test_resync_of_someone_elses_playlist_is_a_404(client, db, monkeypatch):
    """Same reasoning as `_owned`: a 403 would confirm the id exists."""
    from app.models import Playlist

    other = Playlist(user_id=999, name="Theirs", youtube_id="PL9")
    db.add(other)
    await db.commit()
    await db.refresh(other)

    stub_api(monkeypatch, items=fake_items("a"))
    assert (await client.post(f"/api/playlists/{other.id}/resync")).status_code == 404


# --- the owner-only guard ---------------------------------------------------


async def test_only_the_token_owner_may_import(client, db, monkeypatch):
    """The machine holds one YouTube token. Listing "my playlists" for anyone
    else would hand them the owner's, so it refuses and points at the extension.
    """
    from app.models import User
    from app.users import new_api_key

    second = User(email="them@example.test", api_key=new_api_key())
    db.add(second)
    await db.commit()
    await db.refresh(second)

    stub_api(monkeypatch, items=fake_items("a"))
    headers = {"Authorization": f"Bearer {second.api_key}"}

    listed = await client.get("/api/playlists/youtube", headers=headers)
    assert listed.status_code == 400
    assert "extension" in listed.json()["detail"]

    imported = await client.post(
        "/api/playlists/import", json={"youtube_id": "PL1"}, headers=headers
    )
    assert imported.status_code == 400


# --- the extension's path ---------------------------------------------------


async def test_external_import_needs_no_youtube_token(client, monkeypatch):
    """The whole point: the videos travel in the body, so nothing here asks
    YouTube anything. This is what reaches Watch Later and private playlists."""
    monkeypatch.setattr(youtube_api, "fetch_playlist_items", lambda *a, **k: 1 / 0)

    res = await client.post("/api/playlists/import-external", json={
        "youtube_id": "WL",
        "name": "Watch Later",
        "videos": [{"youtube_id": "a", "title": "One"},
                   {"youtube_id": "b", "title": "Two"}],
    })
    assert res.status_code == 200, res.text
    assert res.json()["added"] == 2

    detail = (await client.get(f"/api/playlists/{res.json()['id']}")).json()
    assert detail["name"] == "Watch Later"
    assert detail["youtube_id"] == "WL"


async def test_external_import_works_for_a_non_owner(client, db, seeded_user):
    """A household member with no Google connection at all. The API path refuses
    them; this one is why that refusal is acceptable."""
    from app.models import User
    from app.users import new_api_key

    second = User(email="them@example.test", api_key=new_api_key())
    db.add(second)
    await db.commit()
    await db.refresh(second)

    res = await client.post(
        "/api/playlists/import-external",
        json={"youtube_id": "PL1", "name": "Theirs",
              "videos": [{"youtube_id": "a", "title": "One"}]},
        headers={"Authorization": f"Bearer {second.api_key}"},
    )
    assert res.status_code == 200, res.text

    # And it landed in THEIR list, not the owner's. Both sides are named
    # explicitly: with two accounts on the machine an anonymous request is a
    # 401, not a fall-back to the only person there is.
    owner = (await client.get(
        "/api/playlists", headers={"Authorization": f"Bearer {seeded_user.api_key}"}
    )).json()
    assert owner == []
    theirs = (await client.get(
        "/api/playlists", headers={"Authorization": f"Bearer {second.api_key}"}
    )).json()
    assert [p["name"] for p in theirs] == ["Theirs"]


async def test_external_import_is_idempotent_by_source(client):
    payload = {"youtube_id": "PL1", "name": "Theirs",
               "videos": [{"youtube_id": "a"}, {"youtube_id": "b"}]}
    first = (await client.post("/api/playlists/import-external", json=payload)).json()
    second = (await client.post("/api/playlists/import-external", json=payload)).json()
    assert second["id"] == first["id"]
    assert second["added"] == 0
    assert len((await client.get("/api/playlists")).json()) == 1


async def test_external_import_refuses_an_empty_playlist(client):
    """A page the extension couldn't read yields no videos; creating an empty
    playlist from that would just be litter."""
    res = await client.post(
        "/api/playlists/import-external",
        json={"youtube_id": "PL1", "name": "Nothing", "videos": []},
    )
    assert res.status_code == 400
    assert (await client.get("/api/playlists")).json() == []


async def test_enrichment_fills_gaps_without_clobbering(client, monkeypatch):
    """The extension reads a real duration off the page. A stats answer that
    came back partial must not replace it with a zero."""
    monkeypatch.setattr(youtube_api, "batch_fetch_video_stats", lambda ids: {
        "a": {"duration_seconds": 0, "view_count": 5_000, "like_count": 0},
    })
    res = await client.post("/api/playlists/import-external", json={
        "youtube_id": "PL1",
        "videos": [{"youtube_id": "a", "title": "One", "duration_seconds": 610}],
    })
    (video,) = (await client.get(f"/api/playlists/{res.json()['id']}")).json()["videos"]
    assert video["duration_seconds"] == 610   # kept, not overwritten with 0
    assert video["view_count"] == 5_000       # gap filled


# --- what the rest of the app sees ------------------------------------------


async def test_the_list_marks_which_playlists_came_from_youtube(client, monkeypatch):
    stub_api(monkeypatch, items=fake_items("a"))
    await client.post("/api/playlists/import", json={"youtube_id": "PL1", "name": "Linked"})
    await client.post("/api/playlists", json={"name": "Local"})

    rows = {p["name"]: p for p in (await client.get("/api/playlists")).json()}
    assert rows["Linked"]["youtube_id"] == "PL1"
    assert rows["Local"]["youtube_id"] == ""
    assert rows["Local"]["synced_at"] is None


async def test_an_imported_playlist_behaves_like_any_other(client, monkeypatch):
    """No second class of playlist: you can rename it, remove an item and
    delete it exactly as if you'd built it by hand."""
    stub_api(monkeypatch, items=fake_items("a", "b"))
    pid = (await client.post("/api/playlists/import", json={"youtube_id": "PL1"})).json()["id"]

    await client.patch(f"/api/playlists/{pid}", json={"name": "Renamed"})
    await client.delete(f"/api/playlists/{pid}/items/a")

    detail = (await client.get(f"/api/playlists/{pid}")).json()
    assert detail["name"] == "Renamed"
    assert [v["youtube_id"] for v in detail["videos"]] == ["b"]
    # Still linked, so it can still be re-synced.
    assert detail["youtube_id"] == "PL1"

    assert (await client.delete(f"/api/playlists/{pid}")).status_code == 200
    assert (await client.get("/api/playlists")).json() == []


async def test_the_feeds_own_rows_fill_what_the_page_could_not(client, db, monkeypatch):
    """The extension's real failure mode, and why enrichment reads `videos` first.

    `batch_fetch_video_stats` keeps an hour-long cache and returns nothing for an
    id it fetched recently. A playlist page gives up no view count and no publish
    date, so an extension import of a video the scan touched an hour ago would
    keep a blank view count and no date for good. The feed already holds both.
    """
    from datetime import datetime as dt

    from app.models import Video

    db.add(Video(
        youtube_id="known", channel_id="UC" + "x" * 22,
        title="The full title, which the playlist page truncated",
        view_count=95_183, like_count=2_000, duration_seconds=434,
        published_at=dt(2022, 11, 10), thumbnail_url="https://example.test/k.jpg",
    ))
    await db.commit()

    # The cache is warm: the API contributes nothing at all.
    monkeypatch.setattr(youtube_api, "batch_fetch_video_stats", lambda ids: {})

    res = await client.post("/api/playlists/import-external", json={
        "youtube_id": "PL1",
        "videos": [{"youtube_id": "known", "title": "The full title, which the play…",
                    "duration_seconds": 434}],
    })
    (video,) = (await client.get(f"/api/playlists/{res.json()['id']}")).json()["videos"]
    assert video["view_count"] == 95_183
    assert video["published_at"].startswith("2022-11-10")
    assert video["title"] == "The full title, which the playlist page truncated"


async def test_local_rows_never_clobber_the_numbers_the_page_read(client, db, monkeypatch):
    """Fill-the-gap for the numbers: the page's own duration is real."""
    from datetime import datetime as dt

    from app.models import Video

    db.add(Video(
        youtube_id="known", channel_id="UC" + "x" * 22, title="Whatever",
        view_count=0, like_count=0, duration_seconds=0,
        published_at=dt(2022, 11, 10), thumbnail_url="",
    ))
    await db.commit()
    monkeypatch.setattr(youtube_api, "batch_fetch_video_stats", lambda ids: {})

    res = await client.post("/api/playlists/import-external", json={
        "youtube_id": "PL1",
        "videos": [{"youtube_id": "known", "title": "From the page",
                    "duration_seconds": 610}],
    })
    (video,) = (await client.get(f"/api/playlists/{res.json()['id']}")).json()["videos"]
    assert video["duration_seconds"] == 610  # kept, not overwritten with 0


async def test_the_apps_own_title_wins_even_when_it_is_shorter(client, db, monkeypatch):
    """The title is the one field the app overrides rather than fills.

    The feed asks YouTube for `hl=zh-TW` and stores the LOCALIZED title; a
    playlist page gives whatever language the browser was in. So the two aren't
    a long and a short version of one string — they're different strings, and
    "keep the longer" would put a 100-character English title on a card sitting
    next to the Chinese one the feed shows for the very same video.
    """
    from datetime import datetime as dt

    from app.models import Video

    db.add(Video(
        youtube_id="known", channel_id="UC" + "x" * 22,
        title="我用一個 Claude Skill 省下了訂閱費用",  # 30 chars
        view_count=100, like_count=1, duration_seconds=797,
        published_at=dt(2026, 8, 10), thumbnail_url="",
    ))
    await db.commit()
    monkeypatch.setattr(youtube_api, "batch_fetch_video_stats", lambda ids: {})

    res = await client.post("/api/playlists/import-external", json={
        "youtube_id": "PL1",
        "videos": [{
            "youtube_id": "known",
            # 100 characters, as a playlist page serves them.
            "title": "I Saved a Fortune on AI Subscriptions with This One "
                     "Claude Skill! Stop Overpaying for Image and V...",
        }],
    })
    (video,) = (await client.get(f"/api/playlists/{res.json()['id']}")).json()["videos"]
    assert video["title"] == "我用一個 Claude Skill 省下了訂閱費用"


async def test_the_stats_title_wins_too(client, monkeypatch):
    """Same rule on the other source, for the same reason."""
    monkeypatch.setattr(youtube_api, "batch_fetch_video_stats", lambda ids: {
        "a": {"title": "短標題", "view_count": 10},
    })
    res = await client.post("/api/playlists/import-external", json={
        "youtube_id": "PL1",
        "videos": [{"youtube_id": "a", "title": "A much longer English title from the page"}],
    })
    (video,) = (await client.get(f"/api/playlists/{res.json()['id']}")).json()["videos"]
    assert video["title"] == "短標題"
