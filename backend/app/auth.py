"""Who is asking — the dependency every personal endpoint will take.

Two ways in, because there are two kinds of caller:

  * **A session cookie**, for the app in a browser. Signed with `secret_key`,
    holding nothing but a user id.
  * **A bearer API key**, for the browser extension. It can't use the cookie:
    its worker posts from a youtube.com page context, so the cookie would need
    `SameSite=None` and therefore HTTPS — a lot of ceremony for an app served
    over http://localhost.

The OAuth flow that mints the session lives in `auth_google.py`; this module is
only about reading it back.

Nothing depends on `require_user` yet. It is deliberately landing a stage before
the routers that will take it, so sign-in can be exercised on its own rather than
alongside a rewrite of every query in the app.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session
from app.models import User

# The only thing the cookie carries. Anything else would be a copy of a row that
# can change under it — a stale email in a cookie outlives the account it names.
SESSION_USER_KEY = "user_id"


async def get_db():
    async with async_session() as session:
        yield session


def sign_in(request: Request, user: User) -> None:
    request.session[SESSION_USER_KEY] = user.id


def sign_out(request: Request) -> None:
    request.session.pop(SESSION_USER_KEY, None)


def allowlist() -> set[str]:
    """The emails `ALLOWED_EMAILS` admits, lowercased."""
    return {e.strip().lower() for e in settings.allowed_emails.split(",") if e.strip()}


async def may_sign_in(db: AsyncSession, google_sub: str, email: str) -> bool:
    """Whether this Google account is welcome on this machine.

    **The network is the perimeter.** This app is for a few trusted people
    sharing one box on a home network, so by default anyone who can reach it may
    have an account. A list of permitted emails wouldn't be protecting anything
    a LAN-only bind doesn't already cover — it would just be a list to maintain,
    standing between a family member and the app they were told to use.

    `ALLOWED_EMAILS` stays as an opt-in override, for a deployment reachable more
    widely than its owner would like. Set it and it becomes the answer; leave it
    empty and admission is open.

    Note what this does NOT decide: which row the account lands on. Adoption of
    the pre-accounts data has its own narrow condition in `users.adopt_or_create`,
    so opening signup doesn't open a door onto somebody else's watch history.
    """
    allowed = allowlist()
    if not allowed:
        return True
    if email.lower() in allowed:
        return True
    # Someone who already has an account here keeps it even if they later fall
    # off the list — otherwise trimming the list locks people out mid-session
    # with nothing to tell them why.
    known = (await db.execute(
        select(User).where(User.google_sub == google_sub, User.google_sub != "")
    )).scalar_one_or_none()
    return known is not None


async def _by_api_key(db: AsyncSession, header: str) -> User | None:
    scheme, _, key = header.partition(" ")
    if scheme.lower() != "bearer" or not key.strip():
        return None
    return (await db.execute(
        select(User).where(User.api_key == key.strip())
    )).scalar_one_or_none()


async def optional_user(
    request: Request, db: AsyncSession = Depends(get_db)
) -> User | None:
    """The caller, or None. For endpoints that answer either way."""
    header = request.headers.get("authorization", "")
    if header:
        user = await _by_api_key(db, header)
        if user is not None:
            return user

    # `request.session` only exists once SessionMiddleware is installed; a test
    # or a script driving the app without it should get "nobody", not a crash.
    user_id = (request.scope.get("session") or {}).get(SESSION_USER_KEY)
    if not user_id:
        return None
    return await db.get(User, user_id)


async def require_user(user: User | None = Depends(optional_user)) -> User:
    """The caller, or 401."""
    if user is None:
        raise HTTPException(401, "Not signed in")
    return user


async def user_or_sole(
    user: User | None = Depends(optional_user), db: AsyncSession = Depends(get_db)
) -> User | None:
    """The caller — or, on a machine with exactly one account, that account.

    A transition. The endpoints that own per-user data are being moved over a
    stage at a time, and until the frontend grows a sign-in screen the browser
    is anonymous while the app is very much still one person's. Falling back to
    the sole account keeps that person's app working exactly as it did.

    It stops applying the moment a second account exists, which is the only case
    where guessing would be wrong. Replaced by `require_user` in the stage that
    gives the frontend somewhere to sign in.
    """
    if user is not None:
        return user
    rows = (await db.execute(select(User).limit(2))).scalars().all()
    return rows[0] if len(rows) == 1 else None


async def account(user: User | None = Depends(user_or_sole)) -> User:
    """Whose data this request is about, or 401.

    What every endpoint owning personal rows takes. Same transitional fallback as
    `user_or_sole` — it becomes an alias for `require_user` once the frontend can
    sign in, and the endpoints won't need touching again.
    """
    if user is None:
        raise HTTPException(401, "Sign in first — /api/auth/login")
    return user
