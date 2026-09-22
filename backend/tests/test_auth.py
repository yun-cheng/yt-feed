"""Signing in — who is admitted, which row they land on, and how they're read back."""

import json

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


@pytest.fixture
def open_signup(monkeypatch):
    """Admit anyone who can reach the server, as a LAN deployment does."""
    monkeypatch.setattr(settings, "open_signup", True)


async def test_admission_is_closed_by_default(db, allowed):
    """A stranger who finds the URL doesn't get an account.

    This used to be open, on the reasoning that the network is the perimeter —
    true of a box on a home LAN, where a list of emails is a chore rather than a
    lock. It stopped being true when this app became something you can deploy to a
    public address, where the same default hands it to whoever finds it first.
    """
    allowed("")
    assert await auth.may_sign_in(db, "sub-1", "anyone@example.test") is False


async def test_open_signup_puts_the_lan_behaviour_back(db, allowed, open_signup):
    """The flag exists because the old default was RIGHT in its setting, and
    that setting is still the common one — one box, one household."""
    allowed("")
    assert await auth.may_sign_in(db, "sub-1", "anyone@example.test") is True


async def test_the_owner_can_link_google_to_the_account_they_claimed(db, allowed):
    """The case that makes closed-by-default survivable.

    A fresh deployment is claimed with the setup token, which creates an account
    holding no Google identity. The owner then signs in with Google to import
    their subscriptions — and every rule above is about admitting a STRANGER,
    which they are not: they were let in before Google was involved. Without
    this, closing admission locks out the one person who owns the place.
    """
    allowed("")
    owner = await users.ensure_local_user(db)
    await db.commit()

    assert await auth.may_sign_in(db, "sub-1", "me@example.test") is False
    assert await auth.may_sign_in(
        db, "sub-1", "me@example.test", current=owner
    ) is True


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


async def test_open_admission_still_does_not_hand_over_the_seat(db, allowed, open_signup):
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
    assert r.json() == {"signed_in": False, "resolved": False}


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
        "signed_in": True, "resolved": True, "id": user.id,
        "email": "me@example.test", "name": "", "avatar_url": "",
    }


async def test_a_wrong_api_key_is_nobody(client, db):
    await users.ensure_local_user(db)
    await db.commit()
    r = await client.get("/api/auth/me", headers={"Authorization": "Bearer nope"})
    # The sole-account fallback still resolves them; the KEY just named nobody.
    assert r.json()["signed_in"] is False


async def test_a_header_that_is_not_bearer_is_ignored(client, db):
    user = await users.ensure_local_user(db)
    await db.commit()
    r = await client.get("/api/auth/me", headers={"Authorization": user.api_key})
    assert r.json()["signed_in"] is False


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


async def test_signing_in_lands_back_in_the_app(client, google, allowed, open_signup):
    allowed("")
    r = await client.get("/api/auth/callback", params={"code": "x"})
    assert r.status_code in (302, 307)
    assert r.headers["location"] == settings.app_origin


async def test_signing_in_leaves_you_signed_in(client, google, allowed, open_signup):
    allowed("")
    await client.get("/api/auth/callback", params={"code": "x"})

    me = (await client.get("/api/auth/me")).json()
    assert me["signed_in"] is True
    assert me["email"] == "me@example.test"
    assert me["name"] == "Me"


async def test_signing_in_claims_the_seat_the_migration_seeded(
    client, db, google, allowed, open_signup
):
    """The point of the whole exercise: your history is where you left it."""
    allowed("")
    seeded = await users.ensure_local_user(db)
    await db.commit()
    seeded_id, seeded_key = seeded.id, seeded.api_key

    await client.get("/api/auth/callback", params={"code": "x"})

    assert (await client.get("/api/auth/me")).json()["id"] == seeded_id
    assert (await db.execute(select(func.count()).select_from(User))).scalar_one() == 1
    # This session created the row and still holds it in its identity map, with
    # the values it had before the callback's own session wrote to it. Without
    # expiring, `db.get` answers from memory and reports the row as it was.
    db.expire_all()
    seat = await db.get(User, seeded_id)
    # The key is already pasted into the extension by now.
    assert seat.api_key == seeded_key
    # That the sign-in ACTUALLY landed on that row, rather than being refused and
    # leaving `/api/auth/me` to answer from the sole-account fallback — which
    # reads identically from every assertion above. It did once: this test went on
    # passing when admission was closed and the callback refused outright.
    assert seat.google_sub == "sub-1"
    assert seat.email == "me@example.test"


async def test_signing_in_keeps_the_refresh_token(
    client, db, google, allowed, open_signup
):
    allowed("")
    await client.get("/api/auth/callback", params={"code": "x"})
    user = (await db.execute(select(User))).scalars().first()
    assert user.refresh_token == "the-durable-half"


async def test_a_refused_account_is_told_why_and_gets_no_row(client, db, google, allowed):
    """Refused on an unclaimed deployment, so the message points at /setup — the
    only thing that can help when there is no owner to ask for an invite."""
    allowed("someone-else@example.test")
    r = await client.get("/api/auth/callback", params={"code": "x"})

    assert r.status_code == 400
    assert "/setup" in r.text
    assert (await db.execute(select(func.count()).select_from(User))).scalar_one() == 0
    assert (await client.get("/api/auth/me")).json() == {
        "signed_in": False, "resolved": False,
    }


async def test_a_refusal_on_a_claimed_deployment_points_at_the_owner(
    client, db, google, allowed
):
    """The other half of the same message. Here there IS somebody to ask, and
    telling a family member to go and claim the deployment would be wrong — the
    seat is taken and the claim would be refused anyway."""
    allowed("someone-else@example.test")
    await users.ensure_local_user(db)   # somebody owns this one
    await db.commit()

    r = await client.get("/api/auth/callback", params={"code": "x"})

    assert r.status_code == 400
    assert "invite link" in r.text
    assert "/setup" not in r.text


async def test_logging_out_ends_the_session(client, google, allowed, open_signup):
    allowed("")
    await client.get("/api/auth/callback", params={"code": "x"})
    assert (await client.post("/api/auth/logout")).json() == {"signed_in": False}
    # Still `resolved` — one account on the machine, so the app answers as them.
    assert (await client.get("/api/auth/me")).json()["signed_in"] is False


async def test_logging_out_leaves_the_api_key_working(
    client, db, google, allowed, open_signup
):
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


# ── The extension's key ──────────────────────────────────────────────


async def test_the_api_key_is_handed_over_on_request(client, db):
    """It has to be copied into the extension by hand — the extension can't read
    a session cookie from a youtube.com page context."""
    user = await users.ensure_local_user(db)
    await db.commit()

    r = await client.get("/api/auth/api-key")
    assert r.json()["api_key"] == user.api_key
    assert r.json()["app_origin"] == settings.app_origin


async def test_the_key_endpoint_returns_the_callers_own(client, db):
    """There's no route to anybody else's."""
    await users.ensure_local_user(db)
    them = User(google_sub="sub-2", email="them@example.test",
                api_key=users.new_api_key())
    db.add(them)
    await db.commit()

    r = await client.get("/api/auth/api-key",
                         headers={"Authorization": f"Bearer {them.api_key}"})
    assert r.json()["api_key"] == them.api_key


async def test_nobody_gets_a_key_without_an_account(client):
    assert (await client.get("/api/auth/api-key")).status_code == 401


# ── The saved YouTube token ──────────────────────────────────────────


def test_a_saved_token_keeps_the_scopes_it_was_granted(tmp_path, monkeypatch):
    """A token file written before the identity scopes existed must refresh with
    the ONE scope it was granted.

    Passing today's SCOPES here instead would make the refresh ask Google for
    more than the grant covers, and Google answers `invalid_scope` — which reads
    as a dead token. It cost a month of subscriptions: the scan has its own,
    narrower scope list and kept working, so nothing said the daily resync had
    stopped and a channel followed on YouTube never arrived here.
    """
    path = tmp_path / "youtube_oauth_token.json"
    granted = ["https://www.googleapis.com/auth/youtube.readonly"]
    path.write_text(json.dumps({
        "token": "the-short-lived-half",
        "refresh_token": "the-durable-half",
        "token_uri": "https://oauth2.googleapis.com/token",
        "client_id": "client-id",
        "client_secret": "client-secret",
        "scopes": granted,
    }))
    monkeypatch.setattr(auth_google, "TOKEN_PATH", str(path))

    assert auth_google._get_token().scopes == granted


def test_no_token_file_is_nobody_rather_than_a_crash(tmp_path, monkeypatch):
    monkeypatch.setattr(auth_google, "TOKEN_PATH", str(tmp_path / "nope.json"))
    assert auth_google._get_token() is None
