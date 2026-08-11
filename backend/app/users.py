"""Accounts — who the app belongs to, now that it can belong to more than one.

The app spent its whole life single-user: one OAuth token in a file, one
subscriptions.yaml, and every table keyed by a YouTube id with no room for a
second opinion. This module holds the two pieces that open that seam without
disturbing anything yet — seeding the person who is already here, and recording
which channels are theirs.

The identity rule is the interesting part. There is exactly one user before any
of this runs, and they have no Google `sub` because nothing ever asked for one:
the old token file carries YouTube access without saying whose account it is. So
the first Google sign-in *adopts* that row rather than creating a second one
beside it, which is the difference between logging in and finding your history
where you left it, or finding an empty app and a duplicate.
"""

from __future__ import annotations

import json
import os
import secrets
from datetime import datetime
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import Channel, User, UserChannel

# The pre-accounts token, written by the OAuth flow back when there was one of
# everything. Read once by the migration to seed the first user, then ignored.
LEGACY_TOKEN_PATH = Path(settings.config_dir) / "youtube_oauth_token.json"


def new_api_key() -> str:
    """A bearer token for the browser extension. 32 bytes is well past guessing,
    and short enough to paste into a form field without wrapping."""
    return secrets.token_urlsafe(32)


async def ensure_local_user(db: AsyncSession) -> User:
    """The person already using this app, as a row. Idempotent.

    Called by the migration and by nothing else — a second user arrives by
    signing in, not by being seeded. Deliberately does NOT take an email: the
    old token file doesn't record one, and inventing a placeholder would give
    `adopt_or_create` a value it can't distinguish from a real match.
    """
    existing = (await db.execute(select(User).order_by(User.id))).scalars().first()
    if existing is not None:
        return existing

    user = User(google_sub="", email="", name="", api_key=new_api_key())
    db.add(user)
    await db.flush()
    return user


async def adopt_or_create(
    db: AsyncSession, google_sub: str, email: str, name: str = "", avatar_url: str = ""
) -> User:
    """Map a Google account onto a row, claiming the seeded one if it's free.

    Three cases, in the order they're tried:

    1. We've seen this `sub` before — that's the row, refresh its profile.
    2. Nobody has claimed the seeded local user yet, and it's the only row. It
       becomes this account. This fires exactly once, for the person whose
       history and subscriptions the app already holds.
    3. Anyone else: a new row.

    Case 2 is guarded on being the ONLY user rather than merely being unclaimed,
    because with several people already signed in an unclaimed row would be
    ambiguous — and adopting the wrong one hands somebody else's watch history to
    whoever signs in next.
    """
    by_sub = (await db.execute(
        select(User).where(User.google_sub == google_sub)
    )).scalar_one_or_none()

    if by_sub is None:
        total = (await db.execute(select(func.count()).select_from(User))).scalar_one()
        unclaimed = (await db.execute(
            select(User).where(User.google_sub == "")
        )).scalars().first()
        if total == 1 and unclaimed is not None:
            by_sub = unclaimed

    if by_sub is None:
        by_sub = User(api_key=new_api_key())
        db.add(by_sub)

    by_sub.google_sub = google_sub
    by_sub.email = email
    by_sub.name = name
    by_sub.avatar_url = avatar_url
    await db.flush()
    return by_sub


async def backfill_user_channels(db: AsyncSession, user: User) -> int:
    """Give this user every channel the app already holds. Returns how many.

    The one-time bridge from "the channels table IS the subscription list" to
    "a channel is held by whoever holds it". `Channel.source` is copied across
    rather than defaulted, so the hand-added channel stays hand-added and resync
    keeps leaving it alone.

    Idempotent: only channels this user doesn't already hold are added, so
    running it twice does nothing and running it after a new subscription
    arrives picks up just that one.
    """
    held = set((await db.execute(
        select(UserChannel.channel_id).where(UserChannel.user_id == user.id)
    )).scalars().all())

    rows = (await db.execute(select(Channel.youtube_id, Channel.source))).all()
    added = 0
    for channel_id, source in rows:
        if channel_id in held:
            continue
        db.add(UserChannel(
            user_id=user.id,
            channel_id=channel_id,
            source=source or "subscription",
            added_at=datetime.utcnow(),
        ))
        added += 1
    return added


async def held_channel_ids(db: AsyncSession, user: User) -> set[str]:
    """Which channels this person follows."""
    return set((await db.execute(
        select(UserChannel.channel_id).where(UserChannel.user_id == user.id)
    )).scalars().all())


async def hold(
    db: AsyncSession, user: User, channel_id: str, source: str = "subscription"
) -> None:
    """Record that this person follows this channel. Idempotent.

    `source` is updated on a membership that already exists, because subscribing
    on YouTube to a channel you'd added by hand makes it a subscription — it's in
    the live list now, so the resync exemption should stop applying to it.
    """
    row = await db.get(UserChannel, (user.id, channel_id))
    if row is None:
        db.add(UserChannel(user_id=user.id, channel_id=channel_id, source=source))
    else:
        row.source = source


async def release(db: AsyncSession, user: User, channel_ids: list[str]) -> int:
    """Stop following these channels. The channel rows themselves are untouched —
    see `orphaned_channel_ids` for the part that decides whether they can go."""
    if not channel_ids:
        return 0
    result = await db.execute(
        delete(UserChannel).where(
            UserChannel.user_id == user.id,
            UserChannel.channel_id.in_(channel_ids),
        )
    )
    return result.rowcount or 0


async def orphaned_channel_ids(db: AsyncSession, channel_ids: list[str]) -> list[str]:
    """Of these channels, the ones nobody follows any more.

    The hinge of the whole multi-user prune. Unsubscribing used to delete the
    channel and every video under it; with more than one person holding the
    catalog, that would be one person deleting somebody else's feed. So the
    delete is now conditional on this returning the id.
    """
    if not channel_ids:
        return []
    still_held = set((await db.execute(
        select(UserChannel.channel_id).where(UserChannel.channel_id.in_(channel_ids))
    )).scalars().all())
    return [cid for cid in channel_ids if cid not in still_held]


def read_legacy_token() -> dict | None:
    """The pre-accounts OAuth token, if one was ever written."""
    try:
        with open(LEGACY_TOKEN_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return None


async def seed_resync_clock(db: AsyncSession, user: User) -> bool:
    """Carry the resync schedule over from subscriptions.yaml's mtime.

    That file's mtime WAS the clock — a successful resync rewrote it. Without
    this the migrated user has no `last_resync_at`, which reads as "never
    reconciled", and the scheduler would run the destructive prune a few minutes
    after the next restart instead of a day after the last resync.

    Skipped if the clock is already set, so re-running the migration can't drag
    the schedule backwards.
    """
    if user.last_resync_at is not None:
        return False
    try:
        mtime = os.path.getmtime(settings.subscriptions_path)
    except OSError:
        return False
    user.last_resync_at = datetime.utcfromtimestamp(mtime)
    await db.flush()
    return True


async def seed_token_from_legacy_file(db: AsyncSession, user: User) -> bool:
    """Move the old token file's refresh token onto a user row.

    Only the refresh token and its scopes: the access token in that file is
    minutes from expiring and is re-minted from the refresh token anyway.
    Returns whether anything was carried over — a missing file is the ordinary
    case for a fresh install, not a failure.
    """
    data = read_legacy_token()
    if not data or not data.get("refresh_token"):
        return False
    if user.refresh_token:
        return False
    user.refresh_token = data["refresh_token"]
    user.token_scopes = " ".join(data.get("scopes") or [])
    await db.flush()
    return True
