"""Adding a channel by hand — the door into `channels` that isn't a subscription."""

import pytest

from app.channel_lookup import parse_channel_query


# ── Reading what was pasted ──────────────────────────────────


@pytest.mark.parametrize("raw", [
    "UC1234567890abcdefghijkl",
    "https://www.youtube.com/channel/UC1234567890abcdefghijkl",
    "youtube.com/channel/UC1234567890abcdefghijkl/videos",
    "  https://m.youtube.com/channel/UC1234567890abcdefghijkl?foo=1  ",
])
def test_an_id_is_found_wherever_it_sits(raw):
    assert parse_channel_query(raw)["channel_id"] == "UC1234567890abcdefghijkl"


@pytest.mark.parametrize("raw", [
    "@someone",
    "someone",
    "https://www.youtube.com/@someone",
    "https://www.youtube.com/@someone/shorts",
])
def test_a_handle_is_normalised_with_its_at(raw):
    """The API's forHandle wants the @, and someone typing a name won't add it."""
    assert parse_channel_query(raw)["handle"] == "@someone"


def test_a_vanity_url_is_left_for_ytdlp():
    """/c/ and /user/ carry neither an id nor a handle, and the Data API has no
    field for either — so there's nothing to ask it, and the URL goes on whole."""
    parsed = parse_channel_query("https://www.youtube.com/c/SomeName")
    assert "channel_id" not in parsed and "handle" not in parsed
    assert parsed["url"].endswith("/c/SomeName")


def test_nonsense_is_not_a_channel():
    assert parse_channel_query("") == {}
    assert parse_channel_query("https://example.com/watch") == {}


# ── Looking one up, and adding it ────────────────────────────

INFO = {
    "youtube_id": "UC1234567890abcdefghijkl",
    "title": "A Channel",
    "description": "About things.",
    "thumbnail_url": "https://example.test/avatar.jpg",
    "subscriber_count": 4321,
    "topics": ["Sport"],
}


def _noop_scan(channel_id, user_id):
    """The background first scan: yt-dlp against YouTube, then an LLM for tags.
    Both belong to code with its own tests, and neither may run in this suite."""


@pytest.fixture
def resolves(monkeypatch):
    """Stub the resolver — its two halves (Data API, yt-dlp) both need network."""
    from app.routers import channels as channels_mod

    async def _resolve(raw):
        return INFO if raw else None

    monkeypatch.setattr(channels_mod, "_first_scan", _noop_scan)
    monkeypatch.setattr("app.channel_lookup.resolve_channel", _resolve)


async def test_lookup_reports_who_it_is_and_whether_we_have_them(client, resolves):
    r = await client.get("/api/channels/lookup", params={"q": "@someone"})
    assert r.status_code == 200, r.text
    assert r.json()["title"] == "A Channel"
    assert r.json()["known"] is False, "nothing has been added yet"

    await client.post("/api/channels/add", json={"query": "@someone"})

    again = (await client.get("/api/channels/lookup", params={"q": "@someone"})).json()
    assert (again["known"], again["source"]) == (True, "manual")


async def test_lookup_writes_nothing(client, resolves):
    await client.get("/api/channels/lookup", params={"q": "@someone"})
    assert (await client.get("/api/channels")).json() == []


async def test_an_added_channel_joins_the_list(client, resolves):
    r = await client.post("/api/channels/add", json={"query": "@someone"})
    assert r.json()["already"] is False

    (row,) = (await client.get("/api/channels")).json()
    assert row["youtube_id"] == INFO["youtube_id"]
    assert row["title"] == "A Channel"
    assert row["source"] == "manual", "which is what keeps resync from deleting it"


async def test_adding_twice_says_so_and_changes_nothing(client, resolves):
    await client.post("/api/channels/add", json={"query": "@someone"})
    r = await client.post("/api/channels/add", json={"query": "@someone"})
    assert r.json()["already"] is True
    assert len((await client.get("/api/channels")).json()) == 1


async def test_a_link_to_nothing_is_a_404(client, monkeypatch):
    async def _resolve(raw):
        return None

    monkeypatch.setattr("app.channel_lookup.resolve_channel", _resolve)
    assert (await client.post("/api/channels/add", json={"query": "nope"})).status_code == 404


# ── Surviving a resync ───────────────────────────────────────


async def test_resync_leaves_a_hand_added_channel_alone(client, db, monkeypatch, resolves):
    """The whole reason `source` exists. Resync deletes every channel that isn't
    in your live subscription list, and a hand-added one never will be."""
    from datetime import datetime

    from app.models import Channel, Video
    from app.routers import subscriptions as subs_mod

    await client.post("/api/channels/add", json={"query": "@someone"})
    db.add(Video(
        youtube_id="vidAAAAAAAA", channel_id=INFO["youtube_id"], title="A Video",
        published_at=datetime(2026, 1, 2),
    ))
    # One channel you really are subscribed to, so the live list isn't empty.
    db.add(Channel(youtube_id="UCsubbedsubbedsubbedsub", title="Subscribed"))
    await db.commit()

    async def _live():
        return {"channels": [{"youtube_id": "UCsubbedsubbedsubbedsub"}]}

    monkeypatch.setattr("app.auth_google.fetch_subscriptions", _live)
    monkeypatch.setattr(subs_mod, "_write_subscriptions", lambda ids: None)

    async def _sync_all(user, db):
        return {}

    monkeypatch.setattr(subs_mod, "sync_all_from_subscriptions", _sync_all)

    r = await client.post("/api/subscriptions/resync")
    assert r.status_code == 200, r.text
    assert r.json()["pruned_channels"] == 0

    ids = {c["youtube_id"] for c in (await client.get("/api/channels")).json()}
    assert INFO["youtube_id"] in ids


# ── Removing one ─────────────────────────────────────────────


async def test_a_hand_added_channel_can_be_removed(client, resolves):
    await client.post("/api/channels/add", json={"query": "@someone"})
    r = await client.delete(f"/api/channels/{INFO['youtube_id']}")
    assert r.status_code == 200, r.text
    assert (await client.get("/api/channels")).json() == []


async def test_a_subscribed_channel_is_not_removable_here(client, db, seeded_user):
    """Deleting one would last exactly until the next resync put it back."""
    from app import users
    from app.models import Channel

    db.add(Channel(youtube_id="UCsubbedsubbedsubbedsub", title="Subscribed"))
    await db.commit()
    # The membership, not just the channel row: /api/channels lists what you
    # follow, so a catalog row nobody holds is correctly invisible.
    await users.hold(db, seeded_user, "UCsubbedsubbedsubbedsub")
    await db.commit()

    r = await client.delete("/api/channels/UCsubbedsubbedsubbedsub")
    assert r.status_code == 400
    assert len((await client.get("/api/channels")).json()) == 1
