"""Claiming a deployment, and the hole that made it necessary.

Before this existed, a fresh deployment answered `PUT /api/settings` to anybody:
the database is empty, so `auth.user_or_sole` resolves nobody, and "nobody" was
treated as "go ahead". That was survivable while this app only ran on a home LAN
and only held preferences. It stopped being survivable in the same change, twice
over — the app became something you deploy to a public URL, and those settings
became where the API keys live.

So the tests here are mostly refusals, and the one that matters most is the very
first: an anonymous stranger cannot configure an unclaimed deployment.
"""

import pytest

from app import bootstrap, users
from app.routers.setup import TOKEN_HEADER

# About accounts, so the users table has to start empty.
pytestmark = pytest.mark.no_seeded_user


@pytest.fixture
def token(tmp_path, monkeypatch):
    """A setup token on a data dir of this test's own."""
    from app.config import settings

    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    bootstrap._ensure_setup_token()
    return bootstrap.setup_token()


# ── The hole ─────────────────────────────────────────────────────────


async def test_an_unclaimed_deployment_refuses_to_be_configured_by_a_stranger(
    client, token
):
    """The whole reason this module exists.

    An OpenRouter key is somebody's money and a Google client is somebody's Cloud
    project; both are set through this endpoint. On a fresh deployment there is
    nobody to authenticate as, so something other than authentication has to
    stand here.
    """
    r = await client.put("/api/settings", json={"values": {"openrouter_api_key": "sk-x"}})

    assert r.status_code == 403
    assert "claimed" in r.text


async def test_a_wrong_token_is_refused(client, token):
    r = await client.put(
        "/api/settings",
        json={"values": {"openrouter_api_key": "sk-x"}},
        headers={TOKEN_HEADER: "not-the-token"},
    )

    assert r.status_code == 403


async def test_the_right_token_gets_through(client, token):
    """Otherwise the setup page couldn't do its job."""
    r = await client.put(
        "/api/settings",
        json={"values": {"openrouter_api_key": "sk-or-v1-example"}},
        headers={TOKEN_HEADER: token},
    )

    assert r.status_code == 200, r.text


async def test_a_claimed_deployment_asks_you_to_sign_in_instead(client, db, token):
    """Not 403-with-a-token-hint: once somebody owns this, the token is no longer
    the answer and pointing at it would send them looking for a dead end."""
    await users.ensure_local_user(db)
    # TWO accounts, because with one the sole-account fallback resolves an
    # anonymous caller as that person and this would be allowed — correctly, and
    # not what's being tested here. The first `adopt_or_create` ADOPTS the seeded
    # row (that's its job); only the second makes a new one.
    await users.adopt_or_create(db, "sub-1", "owner@example.test")
    await users.adopt_or_create(db, "sub-2", "other@example.test")
    await db.commit()

    r = await client.put("/api/settings", json={"values": {"archive_fill_enabled": True}})

    assert r.status_code == 401
    assert "Sign in" in r.text


# ── Status ───────────────────────────────────────────────────────────


async def test_status_says_a_fresh_deployment_needs_claiming(client, token):
    body = (await client.get("/api/setup/status")).json()

    assert body["claimed"] is False
    assert body["token_accepted"] is False   # none offered


async def test_status_confirms_a_token_without_revealing_one(client, token):
    """So the setup page can tell you the token is wrong before you fill the rest
    of the form in. It answers yes/no about what you sent; it never sends one."""
    body = (await client.get(
        "/api/setup/status", headers={TOKEN_HEADER: token}
    )).json()

    assert body["token_accepted"] is True
    assert token not in str(body)


async def test_status_says_claimed_once_somebody_owns_it(client, db, token):
    await users.ensure_local_user(db)
    await db.commit()

    assert (await client.get("/api/setup/status")).json()["claimed"] is True


# ── Claiming ─────────────────────────────────────────────────────────


async def test_claiming_makes_you_the_owner_and_signs_you_in(client, db, token):
    """No Google involved. A deployment that never configures OAuth still needs
    an owner, and `users.ensure_local_user` is the row a Google sign-in later
    adopts — so claiming this way costs nothing later."""
    r = await client.post("/api/setup/claim", json={"token": token})

    assert r.status_code == 200, r.text
    assert r.json()["claimed"] is True
    me = (await client.get("/api/auth/me")).json()
    assert me["signed_in"] is True
    assert me["id"] == await users.owner_id(db)


async def test_claiming_with_the_wrong_token_creates_nobody(client, db, token):
    r = await client.post("/api/setup/claim", json={"token": "nope"})

    assert r.status_code == 403
    assert await users.owner_id(db) is None


async def test_a_second_claim_is_refused(client, db, token):
    """The security model in one test: the token stays on disk, but the window it
    opens shuts the first time anybody walks through it."""
    await client.post("/api/setup/claim", json={"token": token})

    r = await client.post("/api/setup/claim", json={"token": token})

    assert r.status_code == 409
    assert "claimed" in r.text.lower()


async def test_claiming_can_carry_the_oauth_client(client, token):
    """Offered on the claim form only because it saves a round trip — the first
    thing an owner wants is usually to import their subscriptions."""
    r = await client.post("/api/setup/claim", json={
        "token": token,
        "google_client_id": "123.apps.googleusercontent.com",
        "google_client_secret": "GOCSPX-example",
    })

    assert r.json()["google_oauth"] is True
    values = (await client.get("/api/settings")).json()["values"]
    assert values["google_client_id"]["set"] is True
    # And still not readable back.
    assert "123.apps.googleusercontent.com" not in str(values)


async def test_signing_in_with_google_is_refused_before_the_claim(client, db, token):
    """The other door into the same room. If a Google sign-in could create the
    first account, the claim would be decoration — whoever signed in first would
    own the deployment."""
    from app import auth

    assert await auth.may_sign_in(db, "sub-1", "first@example.test") is False
