"""The household — adding the people who share this app, and letting them in.

Google sign-in works for whoever runs the server and nobody else: Google accepts
an `http` OAuth callback only on `localhost`/`127.0.0.1`, and everyone else
reaches a home server at `192.168.something`. Registering that address is not
allowed, so the rest of the household needs a way in that doesn't involve
Google at all.

A **login link** is that way. You add a person here, send them the link, and
opening it signs them in on that device and keeps them signed in. No password to
choose, no account to create, nothing to configure — which matters, because the
people using this didn't ask for an identity system, they asked to watch videos.

The link IS the credential, so it's durable rather than single-use (the same one
has to work on a phone, a laptop, and again after a cleared cookie jar) and it's
regenerable, which is how you take it back.
"""

from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth, users
from app.database import async_session
from app.models import User

router = APIRouter(prefix="/users")


async def get_db():
    async with async_session() as session:
        yield session


class NewPerson(BaseModel):
    name: str


def _new_login_token() -> str:
    return secrets.token_urlsafe(24)


def _serialize(u: User, *, me: int) -> dict:
    return {
        "id": u.id,
        "name": u.name or u.email or f"Person {u.id}",
        "email": u.email,
        "avatar_url": u.avatar_url,
        # Whether this person signs in with Google or with a link. Not a role:
        # everyone here is equally trusted, it only decides what to show.
        "google": bool(u.google_sub),
        "is_you": u.id == me,
        "created_at": u.created_at.isoformat() if u.created_at else None,
    }


@router.get("")
async def list_people(
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Everyone with an account here."""
    rows = (await db.execute(select(User).order_by(User.id))).scalars().all()
    return [_serialize(u, me=user.id) for u in rows]


@router.post("")
async def add_person(
    body: NewPerson,
    request: Request,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Add someone, and return the link that signs them in.

    Also signs the CALLER in properly, which looks odd until you see what it
    avoids. On a one-account machine the owner is resolved by the sole-account
    fallback rather than by any session — and adding a second account is exactly
    the moment that fallback stops applying. Without this, creating the first
    family account would log the owner out of their own app, mid-click.
    """
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Give them a name.")

    person = User(
        name=name,
        api_key=users.new_api_key(),
        login_token=_new_login_token(),
    )
    db.add(person)
    auth.sign_in(request, user)
    await db.commit()
    await db.refresh(person)

    # The TOKEN, not a finished URL. This request arrives through the frontend's
    # dev-server proxy, which doesn't forward the browser's Host — so everything
    # here sees `localhost:8000` and would build a link only the server itself
    # can open. The browser knows the address the household actually uses, so it
    # composes the link (see People.tsx).
    return {**_serialize(person, me=user.id), "login_token": person.login_token}


@router.post("/{user_id}/link")
async def reset_link(
    user_id: int,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Mint a fresh login link, retiring the old one.

    The only revocation a link-based sign-in has. Their existing sessions
    survive — the cookie was already issued — so this stops a link being reused,
    not a person being logged in. Removing the account is the other lever.
    """
    person = await db.get(User, user_id)
    if person is None:
        raise HTTPException(404, "No such person")
    person.login_token = _new_login_token()
    await db.commit()
    return {"login_token": person.login_token}


@router.delete("/{user_id}")
async def remove_person(
    user_id: int,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Remove an account and everything personal in it.

    Refuses two things. The last account, because an app with no accounts can't
    be signed into and the sole-account fallback would have nothing to fall back
    to. And yourself, because doing it by accident is easy and undoing it isn't.

    The catalog is untouched: channels and videos are shared, and the channels
    this person was the last to follow are left in place rather than pruned —
    reclaiming them is the resync's job, and it has guards this doesn't.
    """
    from app.models import (
        Bookmark, ChannelTag, ChannelTagRejection, HiddenChannel, Playlist,
        PlaylistItem, UserChannel, UserImport, UserSetting, WatchHistory, WatchLater,
    )
    from sqlalchemy import delete as sa_delete

    if user_id == user.id:
        raise HTTPException(400, "You can't remove your own account.")
    person = await db.get(User, user_id)
    if person is None:
        raise HTTPException(404, "No such person")
    total = (await db.execute(select(func.count()).select_from(User))).scalar_one()
    if total <= 1:
        raise HTTPException(400, "That's the only account here.")

    playlist_ids = (await db.execute(
        select(Playlist.id).where(Playlist.user_id == user_id)
    )).scalars().all()
    if playlist_ids:
        await db.execute(
            sa_delete(PlaylistItem).where(PlaylistItem.playlist_id.in_(playlist_ids))
        )
    for model in (
        WatchHistory, WatchLater, Bookmark, HiddenChannel, Playlist, ChannelTag,
        ChannelTagRejection, UserChannel, UserImport, UserSetting,
    ):
        await db.execute(sa_delete(model).where(model.user_id == user_id))
    await db.delete(person)
    await db.commit()
    return {"status": "ok"}


@router.get("/join/{token}")
async def join(token: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Follow a login link: become that person on this device, and land in the app.

    A GET because it's a link someone taps in a message. That makes it visible
    in history and to anything reading the URL, which is the trade a link-based
    sign-in makes — acceptable for a household on its own network, and the
    reason the token can be regenerated.
    """
    person = (await db.execute(
        select(User).where(User.login_token == token)
    )).scalar_one_or_none()
    if person is None:
        raise HTTPException(404, "That link isn't valid any more. Ask for a new one.")

    auth.sign_in(request, person)
    # Relative on purpose: it lands them at the app root on whatever host they
    # opened the link from, which is the one address known to work for them.
    return RedirectResponse("/")
