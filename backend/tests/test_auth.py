"""Signing in — who is admitted, which row they land on, and how they're read back."""

import pytest
from sqlalchemy import func, select

from app import auth, auth_google, users
from app.config import settings
from app.models import User

# These tests are ABOUT accounts, so they need the users table empty — the
# suite's autouse fixture seeds one for everything else.
pytestmark = pytest.mark.no_seeded_user


# ── Admission: who is allowed to sign in at all ──────────────────────


@pytest.fixture
def allowed(monkeypatch):
    """Set ALLOWED_EMAILS for one test."""
    def apply(value: str):
        monkeypatch.setattr(settings, "allowed_emails", value)
    return apply


async def test_admission_is_open_by_default(db, allowed):
    """The network is the perimeter. On a LAN-only bind, anyone who can reach
    the app is already in the household — a list of emails would be a chore to
    maintain rather than a lock."""
    allowed("")
    assert await auth.may_sign_in(db, "sub-1", "anyone@example.test") is True


async def test_the_allowlist_is_the_whole_answer_when_set(db, allowed):
    """The opt-in override, for a deployment reachable more widely."""
    allowed("me@example.test, you@example.test")
    assert await auth.may_sign_in(db, "sub-1", "me@example.test") is True
    assert await auth.may_sign_in(db, "sub-2", "stranger@example.test") is False


async def test_the_allowlist_ignores_case_and_padding(db, allowed):
    """It's typed by hand into a .env file, so it will have both."""
    allowed("  Me@Example.Test  ")
    assert await auth.may_sign_in(db, "sub-1", "me@example.test") is True


async def test_an_account_already_here_survives_being_trimmed_off_the_list(db, allowed):
    """Otherwise editing the list logs someone out mid-session with nothing to
    tell them why."""
    allowed("someone-else@example.test")
    await users.ensure_local_user(db)
    await users.adopt_or_create(db, "sub-1", "me@example.test")
    await db.commit()

    assert await auth.may_sign_in(db, "sub-1", "me@example.test") is True
    assert await auth.may_sign_in(db, "sub-9", "nobody@example.test") is False


async def test_open_admission_still_does_not_hand_over_the_seat(db, allowed):
    """Being let in and inheriting the pre-accounts data are separate questions.
    Admission is open; adoption keeps its own narrow condition."""
    allowed("")
    await users.ensure_local_user(db)
    mine = await users.adopt_or_create(db, "sub-1", "me@example.test")
    await db.commit()

    assert await auth.may_sign_in(db, "sub-2", "family@example.test") is True
    theirs = await users.adopt_or_create(db, "sub-2", "family@example.test")
    await db.commit()
    assert theirs.id != mine.id


# ── Reading the caller back ──────────────────────────────────────────


async def test_nobody_signed_in_is_an_answer_not_an_error(client):
    """The app asks before it knows, so a 401 here would make every cold load
    look like a failure."""
    r = await client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json() == {"signed_in": False}


async def test_the_extension_is_read_from_its_api_key(client, db):
    """It can't use the session cookie — its worker posts from a youtube.com
    page context, where the cookie would need SameSite=None and HTTPS."""
    user = await users.ensure_local_user(db)
    user.email = "me@example.test"
    await db.commit()

    r = await client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {user.api_key}"}
    )
    assert r.json() == {
        "signed_in": True, "id": user.id, "email": "me@example.test",
        "name": "", "avatar_url": "",
    }


async def test_a_wrong_api_key_is_nobody(client, db):
    await users.ensure_local_user(db)
    await db.commit()
    r = await client.get("/api/auth/me", headers={"Authorization": "Bearer nope"})
    assert r.json() == {"signed_in": False}


async def test_a_header_that_is_not_bearer_is_ignored(client, db):
    user = await users.ensure_local_user(db)
    await db.commit()
    r = await client.get("/api/auth/me", headers={"Authorization": user.api_key})
    assert r.json() == {"signed_in": False}


# ── The whole sign-in, end to end ────────────────────────────────────


class _FakeCredentials:
    token = "an-access-token"
    refresh_token = "the-durable-half"
    token_uri = "https://oauth2.googleapis.com/token"
    client_id = "client-id"
    client_secret = "client-secret"
    scopes = ["openid", "https://www.googleapis.com/auth/youtube.readonly"]


class _FakeFlow:
    redirect_uri = None
    code_verifier = None

    def __init__(self):
        self.credentials = _FakeCredentials()

    def fetch_token(self, code=None):
        return {}


@pytest.fixture
def google(monkeypatch):
    """Stand in for Google: the token exchange and the userinfo lookup."""
    info = {"sub": "sub-1", "email": "me@example.test",
            "name": "Me", "picture": "https://example.test/me.jpg"}

    monkeypatch.setattr(auth_google, "_make_flow", lambda redirect_uri=None: _FakeFlow())

    async def userinfo(access_token):
        return info

    monkeypatch.setattr(auth_google, "_fetch_userinfo", userinfo)
    return info


async def test_signing_in_lands_back_in_the_app(client, google, allowed):
    allowed("")
    r = await client.get("/api/auth/callback", params={"code": "x"})
    assert r.status_code in (302, 307)
    assert r.headers["location"] == settings.app_origin


async def test_signing_in_leaves_you_signed_in(client, google, allowed):
    allowed("")
    await client.get("/api/auth/callback", params={"code": "x"})

    me = (await client.get("/api/auth/me")).json()
    assert me["signed_in"] is True
    assert me["email"] == "me@example.test"
    assert me["name"] == "Me"


async def test_signing_in_claims_the_seat_the_migration_seeded(client, db, google, allowed):
    """The point of the whole exercise: your history is where you left it."""
    allowed("")
    seeded = await users.ensure_local_user(db)
    await db.commit()
    seeded_id, seeded_key = seeded.id, seeded.api_key

    await client.get("/api/auth/callback", params={"code": "x"})

    assert (await client.get("/api/auth/me")).json()["id"] == seeded_id
    assert (await db.execute(select(func.count()).select_from(User))).scalar_one() == 1
    # The key is already pasted into the extension by now.
    assert (await db.get(User, seeded_id)).api_key == seeded_key


async def test_signing_in_keeps_the_refresh_token(client, db, google, allowed):
    allowed("")
    await client.get("/api/auth/callback", params={"code": "x"})
    user = (await db.execute(select(User))).scalars().first()
    assert user.refresh_token == "the-durable-half"


async def test_a_refused_account_is_told_why_and_gets_no_row(client, db, google, allowed):
    allowed("someone-else@example.test")
    r = await client.get("/api/auth/callback", params={"code": "x"})

    assert r.status_code == 400
    assert "ALLOWED_EMAILS" in r.text
    assert (await db.execute(select(func.count()).select_from(User))).scalar_one() == 0
    assert (await client.get("/api/auth/me")).json() == {"signed_in": False}


async def test_logging_out_ends_the_session(client, google, allowed):
    allowed("")
    await client.get("/api/auth/callback", params={"code": "x"})
    assert (await client.post("/api/auth/logout")).json() == {"signed_in": False}
    assert (await client.get("/api/auth/me")).json() == {"signed_in": False}


async def test_logging_out_leaves_the_api_key_working(client, db, google, allowed):
    """Signing out of the browser shouldn't stop the extension recording what
    you watch — they're separate credentials for separate callers."""
    allowed("")
    await client.get("/api/auth/callback", params={"code": "x"})
    await client.post("/api/auth/logout")

    user = (await db.execute(select(User))).scalars().first()
    r = await client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {user.api_key}"}
    )
    assert r.json()["signed_in"] is True
