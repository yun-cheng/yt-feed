"""Claiming a deployment that nobody owns yet.

A fresh deployment has an empty database, and an empty database means
`auth.user_or_sole` resolves nobody — which is why, before this existed, anyone
who loaded the URL first could write the app's settings and then sign in as its
owner. On a LAN that was covered by the network being the perimeter. On a public
URL it is the app handed to whoever finds it.

So a deployment starts **unclaimed**, and stays that way until somebody presents
a token that only the person who ran it can have: `bootstrap` writes it to the
data volume and prints it to the log, and `docker compose logs` is a channel the
open port is not. Claiming creates the first account and signs that browser in.

Two things this is deliberately NOT:

  * **Not a login.** The token works once, in the sense that it stops being
    accepted the moment an account exists. It is not a password and there is
    nothing to rotate — the thing it protects can only happen once.
  * **Not tied to Google.** Claiming creates the local owner row directly, the
    same row `users.ensure_local_user` has always made, so a deployment that
    never configures OAuth still has an owner and a working app. Signing in with
    Google afterwards ADOPTS that row (see `users.adopt_or_create`), which is
    exactly the case adoption was written for.
"""

from __future__ import annotations

import hmac

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app import app_settings, auth, bootstrap, users
from app.database import async_session
from app.models import User

router = APIRouter(prefix="/setup")

# The header a client presents the token in. A header rather than a query
# parameter so it stays out of access logs and browser history.
TOKEN_HEADER = "X-Setup-Token"


async def is_claimed(db: AsyncSession | None = None) -> bool:
    """Whether anybody owns this deployment."""
    if db is not None:
        return await users.owner_id(db) is not None
    async with async_session() as session:
        return await users.owner_id(session) is not None


def _token_ok(request: Request) -> bool:
    """Whether the request carries the setup token.

    `compare_digest` rather than `==`: this compares a secret against attacker-
    supplied input, which is the one comparison where how long it takes is worth
    not leaking. Cheap insurance on a check that runs approximately once.
    """
    expected = bootstrap.setup_token()
    offered = request.headers.get(TOKEN_HEADER, "")
    return bool(expected) and hmac.compare_digest(expected, offered)


async def authorize_write(request: Request, user: User | None) -> None:
    """Guard for the endpoints that configure the deployment.

    Three states, and the middle one is the reason this function exists:

      * **claimed, and you are somebody** — allowed, as before.
      * **unclaimed** — allowed only with the setup token. This is the hole:
        without it, `user` is None on a fresh database and an anonymous caller
        could write every key the app has.
      * **claimed, and you are nobody** — 401. Sign in.
    """
    if user is not None:
        return
    if await is_claimed():
        raise HTTPException(401, "Sign in first — /api/auth/login")
    if not _token_ok(request):
        raise HTTPException(
            403,
            "This deployment hasn't been claimed yet. Read the setup token from "
            "the server log (`docker compose logs app | grep setup`) and open "
            "/setup.",
        )


class Claim(BaseModel):
    token: str
    # Optional, and offered here only because it saves a round trip: the first
    # thing an owner wants is usually to import their subscriptions, which needs
    # an OAuth client. Everything else is set from Settings afterwards.
    google_client_id: str = ""
    google_client_secret: str = ""


@router.get("/status")
async def status(request: Request):
    """Whether this deployment needs setting up, and what it has so far.

    Unauthenticated on purpose — the frontend asks before it can know anything,
    and every field here is a yes/no about configuration rather than a value. It
    says whether a token would be accepted, never what the token is.
    """
    from app.auth_google import oauth_configured

    claimed = await is_claimed()
    return {
        "claimed": claimed,
        # Only meaningful while unclaimed; false afterwards, because the token
        # stops being accepted whatever it says.
        "token_accepted": (not claimed) and _token_ok(request),
        "google_oauth": oauth_configured(),
    }


@router.post("/claim")
async def claim(body: Claim, request: Request):
    """Become the owner of this deployment.

    Refused once there is an owner, and that refusal is the whole security model:
    the token is long-lived on disk, but the window it opens closes the first time
    anybody walks through it.
    """
    async with async_session() as db:
        if await users.owner_id(db) is not None:
            raise HTTPException(
                409, "Already claimed. Sign in, or ask the owner for an invite link."
            )

        expected = bootstrap.setup_token()
        if not expected or not hmac.compare_digest(expected, body.token):
            raise HTTPException(403, "That isn't the setup token.")

        owner = await users.ensure_local_user(db)
        await db.commit()
        auth.sign_in(request, owner)

    oauth = {
        k: v for k, v in (
            ("google_client_id", body.google_client_id.strip()),
            ("google_client_secret", body.google_client_secret.strip()),
        ) if v
    }
    if oauth:
        await app_settings.put(oauth, user_id=owner.id)

    # No "who am I now" endpoint here: `/api/auth/me` already answers that, and it
    # is what the frontend reads after this returns.
    return {"claimed": True, "id": owner.id, "google_oauth": bool(oauth)}
