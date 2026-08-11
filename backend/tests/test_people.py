"""The household — adding people, and the link that lets them in.

Google sign-in is only available to whoever runs the server (Google accepts an
http callback on localhost and nowhere else), so a login link is how the rest of
a family gets an account at all. These tests are about that path.
"""

import pytest
from sqlalchemy import func, select

from app import users
from app.models import User, WatchHistory

pytestmark = pytest.mark.no_seeded_user


@pytest.fixture
async def owner(db):
    """The person already here — resolved by the sole-account fallback, exactly
    as the real app resolves them before anyone else exists."""
    me = await users.ensure_local_user(db)
    me.name = "Me"
    await db.commit()
    return me


# ── Adding someone ───────────────────────────────────────────────────


async def test_adding_someone_returns_a_link_to_send_them(client, owner):
    r = await client.post("/api/users", json={"name": "Sister"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "Sister"
    assert body["google"] is False
    # A token, not a finished URL — the browser composes the link, because the
    # dev-server proxy hides the address the household actually uses.
    assert body["login_token"] and "http" not in body["login_token"]


async def test_a_person_needs_a_name(client, owner):
    assert (await client.post("/api/users", json={"name": "   "})).status_code == 400


async def test_adding_someone_does_not_log_the_owner_out(client, owner, db):
    """The trap this guards: on a one-account box the owner is resolved by the
    sole-account fallback, and adding a second account is the exact moment that
    fallback stops applying. Creating a family account must not sign them out of
    their own app mid-click."""
    await client.post("/api/users", json={"name": "Sister"})

    me = (await client.get("/api/auth/me")).json()
    assert me["signed_in"] is True
    assert me["id"] == owner.id
    # And the app still answers as them, with the fallback no longer available.
    assert (await client.get("/api/history")).status_code == 200


async def test_everyone_is_listed(client, owner):
    await client.post("/api/users", json={"name": "Sister"})
    people = (await client.get("/api/users")).json()
    assert [p["name"] for p in people] == ["Me", "Sister"]
    assert [p["is_you"] for p in people] == [True, False]


# ── Following the link ───────────────────────────────────────────────


async def test_the_link_signs_you_in_as_that_person(client, owner):
    link = (await client.post("/api/users", json={"name": "Sister"})).json()["login_token"]

    r = await client.get(f"/api/users/join/{link}")
    assert r.status_code in (302, 307)

    me = (await client.get("/api/auth/me")).json()
    assert me["signed_in"] is True
    assert me["name"] == "Sister"


async def test_the_link_lands_you_in_the_app(client, owner):
    """Relative, so it works on whatever address they opened it from — an
    absolute one built on the owner's `localhost` would be a dead end."""
    link = (await client.post("/api/users", json={"name": "Sister"})).json()["login_token"]
    r = await client.get(f"/api/users/join/{link}")
    assert r.headers["location"] == "/"


async def test_the_same_link_works_again(client, owner):
    """It has to: one link, a phone and a laptop, and again after a cleared
    cookie jar."""
    link = (await client.post("/api/users", json={"name": "Sister"})).json()["login_token"]
    path = f"/api/users/join/{link}"

    await client.get(path)
    await client.post("/api/auth/logout")
    await client.get(path)
    assert (await client.get("/api/auth/me")).json()["name"] == "Sister"


async def test_a_made_up_link_is_refused(client, owner):
    assert (await client.get("/api/users/join/not-a-real-token")).status_code == 404


async def test_resetting_the_link_retires_the_old_one(client, owner, db):
    """The only revocation a link-based sign-in has."""
    made = (await client.post("/api/users", json={"name": "Sister"})).json()
    old = made["login_token"]

    fresh = (await client.post(f"/api/users/{made['id']}/link")).json()["login_token"]
    assert fresh != old

    assert (await client.get(f"/api/users/join/{old}")).status_code == 404
    assert (await client.get(f"/api/users/join/{fresh}")).status_code in (302, 307)


# ── What a link-signed-in person gets ────────────────────────────────


async def test_they_get_their_own_history_not_the_owners(client, owner, db):
    await client.post("/api/history", json={
        "youtube_id": "vid1", "position_seconds": 100.0, "duration_seconds": 600,
    })
    link = (await client.post("/api/users", json={"name": "Sister"})).json()["login_token"]

    await client.get(f"/api/users/join/{link}")
    assert (await client.get("/api/history")).json() == []
    assert (await client.get("/api/history/vid1")).json() == {}


async def test_they_get_their_own_extension_key(client, owner):
    made = (await client.post("/api/users", json={"name": "Sister"})).json()
    await client.get(f"/api/users/join/{made['login_token']}")

    key = (await client.get("/api/auth/api-key")).json()["api_key"]
    assert key and key != owner.api_key


# ── Removing someone ─────────────────────────────────────────────────


async def test_removing_someone_takes_their_data_with_them(client, owner, db):
    made = (await client.post("/api/users", json={"name": "Sister"})).json()
    await client.get(f"/api/users/join/{made['login_token']}")
    await client.post("/api/history", json={
        "youtube_id": "vid1", "position_seconds": 100.0, "duration_seconds": 600,
    })
    await client.post("/api/auth/logout")

    # Back as the owner, via the API key so the fallback isn't what's tested.
    headers = {"Authorization": f"Bearer {owner.api_key}"}
    assert (await client.delete(f"/api/users/{made['id']}", headers=headers)).status_code == 200

    assert (await db.execute(select(func.count()).select_from(User))).scalar_one() == 1
    assert (await db.execute(
        select(func.count()).select_from(WatchHistory)
    )).scalar_one() == 0


async def test_you_cannot_remove_yourself(client, owner):
    await client.post("/api/users", json={"name": "Sister"})
    r = await client.delete(f"/api/users/{owner.id}")
    assert r.status_code == 400


async def test_the_last_account_cannot_be_removed(client, owner, db):
    """An app with no accounts can't be signed into, and the sole-account
    fallback would have nothing to fall back to."""
    other = User(name="Other", api_key=users.new_api_key())
    db.add(other)
    await db.commit()

    headers = {"Authorization": f"Bearer {other.api_key}"}
    assert (await client.delete(f"/api/users/{owner.id}", headers=headers)).status_code == 200
    # `other` is now the only one, and is deleting themselves — refused twice over.
    assert (await client.delete(f"/api/users/{other.id}", headers=headers)).status_code == 400


async def test_someone_elses_playlist_items_go_too(client, owner, db):
    """`playlist_items` has no user_id of its own, so it has to be reached
    through the playlists being deleted or it would outlive them."""
    from app.models import PlaylistItem

    made = (await client.post("/api/users", json={"name": "Sister"})).json()
    await client.get(f"/api/users/join/{made['login_token']}")
    pid = (await client.post("/api/playlists", json={"name": "Theirs"})).json()["id"]
    await client.post(f"/api/playlists/{pid}/items", json={"youtube_id": "vid1"})
    await client.post("/api/auth/logout")

    headers = {"Authorization": f"Bearer {owner.api_key}"}
    await client.delete(f"/api/users/{made['id']}", headers=headers)

    assert (await db.execute(
        select(func.count()).select_from(PlaylistItem)
    )).scalar_one() == 0
