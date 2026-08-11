"""Accounts — seeding the person already here, and letting Google claim them."""

import json
import os
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app import users
from app.database import async_session
from app.models import Channel, User, UserChannel

# These tests are ABOUT accounts, so they need the users table empty — the
# suite's autouse fixture seeds one for everything else.
pytestmark = pytest.mark.no_seeded_user


async def _channels(db, *specs):
    for youtube_id, source in specs:
        db.add(Channel(youtube_id=youtube_id, title=youtube_id, source=source))
    await db.commit()


# ── Seeding ──────────────────────────────────────────────────────────


async def test_the_person_already_here_becomes_user_one(db):
    user = await users.ensure_local_user(db)
    await db.commit()
    assert user.id == 1
    assert user.api_key


async def test_seeding_twice_does_not_make_a_second_person(db):
    """The migration is documented as safe to run again, and someone will."""
    first = await users.ensure_local_user(db)
    await db.commit()
    second = await users.ensure_local_user(db)
    await db.commit()
    assert first.id == second.id
    assert (await db.execute(select(func.count()).select_from(User))).scalar_one() == 1


async def test_the_seeded_user_has_no_google_account_yet(db):
    """`google_sub` is what `adopt_or_create` matches on, so an invented
    placeholder here would be indistinguishable from a real sign-in."""
    user = await users.ensure_local_user(db)
    await db.commit()
    assert user.google_sub == ""
    assert user.email == ""


async def test_api_keys_differ_between_people(db):
    a = users.new_api_key()
    b = users.new_api_key()
    assert a != b and len(a) > 20


# ── The one-time channel backfill ────────────────────────────────────


async def test_backfill_hands_over_every_channel(db):
    await _channels(db, ("chanA", "subscription"), ("chanB", "subscription"))
    user = await users.ensure_local_user(db)
    assert await users.backfill_user_channels(db, user) == 2
    await db.commit()

    held = (await db.execute(
        select(UserChannel.channel_id).where(UserChannel.user_id == user.id)
    )).scalars().all()
    assert set(held) == {"chanA", "chanB"}


async def test_a_hand_added_channel_stays_hand_added(db):
    """`source` decides whether resync is allowed to prune it. Defaulting it
    here would quietly re-arm the prune against a channel you added yourself."""
    await _channels(db, ("subbed", "subscription"), ("byhand", "manual"))
    user = await users.ensure_local_user(db)
    await users.backfill_user_channels(db, user)
    await db.commit()

    rows = {
        r.channel_id: r.source for r in
        (await db.execute(select(UserChannel))).scalars().all()
    }
    assert rows == {"subbed": "subscription", "byhand": "manual"}


async def test_backfilling_twice_adds_nothing(db):
    await _channels(db, ("chanA", "subscription"))
    user = await users.ensure_local_user(db)
    await users.backfill_user_channels(db, user)
    await db.commit()
    assert await users.backfill_user_channels(db, user) == 0


async def test_backfill_picks_up_a_channel_that_arrived_later(db):
    """Which is what makes re-running the migration useful rather than merely
    harmless — subscriptions keep arriving while the seam is half-open."""
    await _channels(db, ("chanA", "subscription"))
    user = await users.ensure_local_user(db)
    await users.backfill_user_channels(db, user)
    await db.commit()

    await _channels(db, ("chanB", "subscription"))
    assert await users.backfill_user_channels(db, user) == 1


# ── Identity: which row a Google account lands on ────────────────────


async def test_the_first_sign_in_adopts_the_seeded_user(db):
    """The whole point. Signing in for the first time has to find the history
    and subscriptions the app already holds, not an empty app beside them."""
    seeded = await users.ensure_local_user(db)
    await db.commit()

    user = await users.adopt_or_create(db, "sub-123", "me@example.test", "Me")
    await db.commit()

    assert user.id == seeded.id
    assert user.email == "me@example.test"
    assert (await db.execute(select(func.count()).select_from(User))).scalar_one() == 1


async def test_the_adopted_user_keeps_their_api_key(db):
    """It's already pasted into the extension by the time anyone signs in."""
    seeded = await users.ensure_local_user(db)
    await db.commit()
    key = seeded.api_key

    user = await users.adopt_or_create(db, "sub-123", "me@example.test")
    await db.commit()
    assert user.api_key == key


async def test_signing_in_again_returns_the_same_row(db):
    await users.ensure_local_user(db)
    await db.commit()
    first = await users.adopt_or_create(db, "sub-123", "me@example.test")
    await db.commit()
    again = await users.adopt_or_create(db, "sub-123", "me@example.test", "Me Renamed")
    await db.commit()

    assert again.id == first.id
    assert again.name == "Me Renamed"
    assert (await db.execute(select(func.count()).select_from(User))).scalar_one() == 1


async def test_the_second_person_gets_their_own_row(db):
    await users.ensure_local_user(db)
    await db.commit()
    mine = await users.adopt_or_create(db, "sub-123", "me@example.test")
    await db.commit()
    theirs = await users.adopt_or_create(db, "sub-456", "you@example.test")
    await db.commit()

    assert theirs.id != mine.id
    assert (await db.execute(select(func.count()).select_from(User))).scalar_one() == 2


async def test_adoption_never_fires_once_there_are_two_people(db):
    """An unclaimed row among several is ambiguous, and guessing hands one
    person's watch history to whoever signs in next.

    Contrived on purpose — it takes a hand-made second row to get here, which is
    exactly the accident this guard exists for.
    """
    await users.ensure_local_user(db)  # unclaimed
    db.add(User(google_sub="sub-999", email="other@example.test",
                api_key=users.new_api_key()))
    await db.commit()

    arriving = await users.adopt_or_create(db, "sub-123", "me@example.test")
    await db.commit()

    assert arriving.google_sub == "sub-123"
    assert arriving.email == "me@example.test"
    assert (await db.execute(select(func.count()).select_from(User))).scalar_one() == 3


# ── The old token file ───────────────────────────────────────────────


@pytest.fixture
def legacy_token(tmp_root, monkeypatch):
    """Stand in for config/youtube_oauth_token.json."""
    path = tmp_root / "legacy_token.json"
    # tmp_root is session-scoped, so a file written by an earlier test would
    # still be sitting there for the one that asserts there is no token.
    path.unlink(missing_ok=True)
    monkeypatch.setattr(users, "LEGACY_TOKEN_PATH", path)

    def write(**over):
        path.write_text(json.dumps({
            "token": "expired-access-token",
            "refresh_token": "the-durable-half",
            "scopes": ["https://www.googleapis.com/auth/youtube.readonly"],
            **over,
        }))

    return write


async def test_the_old_token_moves_onto_the_user(db, legacy_token):
    legacy_token()
    user = await users.ensure_local_user(db)
    assert await users.seed_token_from_legacy_file(db, user) is True
    await db.commit()

    assert user.refresh_token == "the-durable-half"
    assert "youtube.readonly" in user.token_scopes


async def test_the_expiring_access_token_is_left_behind(db, legacy_token):
    """It's minutes from dead and re-minted from the refresh token anyway."""
    legacy_token()
    user = await users.ensure_local_user(db)
    await users.seed_token_from_legacy_file(db, user)
    await db.commit()
    assert "expired-access-token" not in (user.refresh_token or "")


async def test_a_fresh_install_has_no_token_to_move(db, legacy_token):
    """A missing file is the ordinary case, not a failure — the migration runs
    on a machine that has never signed in."""
    user = await users.ensure_local_user(db)
    assert await users.seed_token_from_legacy_file(db, user) is False


@pytest.fixture
def legacy_subscriptions():
    """config/subscriptions.yaml, at a chosen mtime. conftest already points
    CONFIG_DIR at a temp directory, and `subscriptions_path` derives from it."""
    from app.config import settings

    path = Path(settings.subscriptions_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    def write(mtime: float):
        path.write_text("subscriptions: []\n")
        os.utime(path, (mtime, mtime))

    yield write
    path.unlink(missing_ok=True)


async def test_the_resync_clock_comes_from_the_old_file(db, legacy_subscriptions):
    """Without it the migrated user reads as "never reconciled", and the
    scheduler runs the DESTRUCTIVE prune minutes after the next restart instead
    of a day after the last resync."""
    legacy_subscriptions(1_770_000_000)

    user = await users.ensure_local_user(db)
    assert await users.seed_resync_clock(db, user) is True
    await db.commit()
    assert user.last_resync_at == datetime.utcfromtimestamp(1_770_000_000)


async def test_a_machine_that_never_resynced_has_no_clock_to_carry(db):
    user = await users.ensure_local_user(db)
    assert await users.seed_resync_clock(db, user) is False
    assert user.last_resync_at is None


async def test_the_resync_clock_is_never_dragged_backwards(db, legacy_subscriptions):
    """Re-running the migration after a resync must not re-arm it."""
    legacy_subscriptions(1_770_000_000)

    user = await users.ensure_local_user(db)
    user.last_resync_at = datetime(2026, 8, 1)
    await db.commit()

    assert await users.seed_resync_clock(db, user) is False
    assert user.last_resync_at == datetime(2026, 8, 1)


async def test_a_token_already_moved_is_not_overwritten(db, legacy_token):
    """Re-running the migration after a re-auth must not put the stale refresh
    token back over the live one."""
    legacy_token()
    user = await users.ensure_local_user(db)
    await users.seed_token_from_legacy_file(db, user)
    user.refresh_token = "refreshed-since"
    await db.commit()

    assert await users.seed_token_from_legacy_file(db, user) is False
    assert user.refresh_token == "refreshed-since"


# ── The migration guard ──────────────────────────────────────────────


@pytest.fixture
async def legacy_watch_history():
    """A `watch_history` shaped the way it was before accounts.

    `fresh_db` rebuilds the schema for the next test, so the damage stops here.
    """
    from sqlalchemy import text

    from app.database import Base, engine

    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE IF EXISTS watch_history"))
        await conn.execute(text(
            "CREATE TABLE watch_history ("
            "youtube_id VARCHAR NOT NULL PRIMARY KEY, "
            "position_seconds FLOAT NOT NULL DEFAULT 0, "
            "duration_seconds INTEGER NOT NULL DEFAULT 0)"
        ))
    yield
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE IF EXISTS watch_history"))
        await conn.run_sync(Base.metadata.create_all)


async def test_startup_refuses_a_database_that_predates_per_user_data(legacy_watch_history):
    """Serving it would filter every personal query on a column that isn't
    there: a hundred identical OperationalErrors and no sign of the one thing
    that fixes them."""
    from app.database import MigrationRequired, init_db

    with pytest.raises(MigrationRequired) as caught:
        await init_db()
    assert "migrate_personal_tables" in str(caught.value)
    assert "watch_history" in str(caught.value)


async def test_the_migration_itself_is_let_through(legacy_watch_history):
    """The regression: `migrate_multiuser` opens with `init_db()`, and the
    database it exists to migrate is exactly the shape the guard rejects. With
    the check on, neither script could go first and an existing install had no
    path forward at all."""
    from app.database import init_db

    await init_db(assert_migrated=False)  # must not raise

    # And it did its job: the tables the migration needs are now there.
    async with async_session() as session:
        assert (await session.execute(select(func.count()).select_from(User))
                ).scalar_one() == 0
