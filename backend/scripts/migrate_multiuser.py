"""
Turn this database into one that can hold more than one person.

The app was single-user by construction: the channels table WAS the subscription
list, and the OAuth token in config/ was the whole of "who is logged in". This
opens the seam — it seeds you as user 1, hands you every channel the app already
holds, moves the old token file's refresh token onto your row, and carries the
resync schedule over from subscriptions.yaml's mtime.

Additive on purpose. No existing table is altered and no row is deleted. The step
that widens the personal tables' primary keys is a separate, destructive
migration that comes with the code that needs it.

**Run this before starting the app** on a database that predates accounts:
`user_channels` is what the app now believes you follow, and an empty one means
an empty feed.

Safe to run twice: every step is idempotent, so running it again after
subscribing to something new just picks that up. The resync clock is only ever
set when it's unset, so a re-run can't drag the schedule backwards.

Run from the backend directory:
    python -m scripts.migrate_multiuser
    python -m scripts.migrate_multiuser --dry-run
"""
import asyncio
import sys

from sqlalchemy import func, select

from app import users
from app.database import async_session, init_db
from app.models import Channel, User, UserChannel


async def main(dry_run: bool = False) -> int:
    # Creates the users / user_channels tables if they aren't there yet.
    #
    # Without the migration check: this script exists to be run on a database
    # that predates accounts, which is exactly what that check refuses to open.
    # The five widened tables are `scripts/migrate_personal_tables`'s job, and
    # that one needs the `users` row this script seeds — so this has to be able
    # to go first.
    await init_db(assert_migrated=False)

    async with async_session() as session:
        channels = (await session.execute(
            select(func.count()).select_from(Channel)
        )).scalar_one()
        existing_users = (await session.execute(
            select(func.count()).select_from(User)
        )).scalar_one()

        if dry_run:
            held = (await session.execute(
                select(func.count()).select_from(UserChannel)
            )).scalar_one()
            print(f"users: {existing_users}")
            print(f"channels: {channels}, memberships already recorded: {held}")
            print(f"would add up to {channels - held} membership(s)")
            print(f"legacy token: {'found' if users.read_legacy_token() else 'none'}")
            return 0

        user = await users.ensure_local_user(session)
        created = existing_users == 0
        print(f"{'created' if created else 'found'} user {user.id}")

        added = await users.backfill_user_channels(session, user)
        print(f"gave user {user.id} {added} channel(s)")

        if await users.seed_token_from_legacy_file(session, user):
            print(f"moved the OAuth refresh token onto user {user.id}")
        else:
            print("no OAuth token to move (already moved, or never signed in)")

        if await users.seed_resync_clock(session, user):
            print(f"resync clock carried over: {user.last_resync_at:%Y-%m-%d %H:%M} UTC")
        else:
            print("resync clock already set (or nothing to carry over)")

        await session.commit()

    print("\nDone. Your API key, for the extension later:")
    print(f"  {user.api_key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(dry_run="--dry-run" in sys.argv)))
