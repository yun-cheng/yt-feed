from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.pool import NullPool

from app.config import settings

engine = create_async_engine(
    f"sqlite+aiosqlite:///{settings.db_path}",
    # The background scan runs in its own thread with its own event loop while
    # using this same engine. A pooled async connection created on one loop and
    # then reused on another hangs forever: aiosqlite delivers each result back
    # to the loop that created the connection, so the other loop's `await` waits
    # on a Future that never resolves — the connection stays checked out and the
    # pool gets poisoned, wedging the server. NullPool means every session opens
    # and closes its own connection on its own loop, so nothing is shared across
    # loops. Load is tiny, so the per-request reconnect cost is negligible.
    poolclass=NullPool,
    # Wait (up to 30s) instead of erroring if the DB file is briefly locked —
    # WAL still serializes writers (the scan's commits vs. a request's write).
    connect_args={"timeout": 30},
)
async_session = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


# Lightweight additive migrations: create_all makes new TABLES but never adds
# COLUMNS to existing ones. Each entry: (table, column, DDL type + default).
_COLUMN_MIGRATIONS = [
    ("videos", "is_short", "BOOLEAN NOT NULL DEFAULT 0"),
    ("channels", "topics", "TEXT DEFAULT ''"),
    ("channels", "llm_labels", "TEXT DEFAULT ''"),
    # No default → existing rows become NULL, which means "not labeled yet".
    ("channels", "video_label_vocab", "TEXT"),
    ("channels", "video_label_version", "INTEGER"),
    ("videos", "title_labels", "TEXT"),
    ("local_videos", "probed", "BOOLEAN NOT NULL DEFAULT 0"),
    ("channels", "label_stop_words", "TEXT"),
    # Archive fill: the resume cursor, the "nothing left to fetch" flag, and the
    # cached lifetime upload count. NULL cursor = never walked.
    ("channels", "archive_cursor", "TEXT"),
    ("channels", "archive_exhausted", "BOOLEAN NOT NULL DEFAULT 0"),
    ("channels", "lifetime_count", "INTEGER"),
    # Existing rows were all deliberate imports, which is exactly what the
    # default says — so the backfill needs no separate pass.
    ("imported_videos", "source", "TEXT NOT NULL DEFAULT 'import'"),
    # The uploader's avatar, which imported/history rows have always carried and
    # these three never did — so their cards drew the fallback initial. Existing
    # rows come out blank and are repaired by scripts/fix_channel_avatars.py.
    ("watch_later", "channel_thumbnail", "TEXT DEFAULT ''"),
    ("downloads", "channel_thumbnail", "TEXT DEFAULT ''"),
    ("playlist_items", "channel_thumbnail", "TEXT DEFAULT ''"),
    # Every channel that predates hand-adding arrived from a subscription, which
    # is what the default says — so there's no backfill pass to run.
    ("channels", "source", "TEXT NOT NULL DEFAULT 'subscription'"),
    # Accounts. These two tables have autoincrement ids, so a plain column is
    # enough and every existing row belongs to user 1 — the person who was here
    # before there were accounts. The five tables whose PRIMARY KEY had to widen
    # can't be done this way and are rebuilt by scripts/migrate_personal_tables.py.
    ("bookmarks", "user_id", "INTEGER NOT NULL DEFAULT 1"),
    ("playlists", "user_id", "INTEGER NOT NULL DEFAULT 1"),
    # Nullable: only accounts that sign in without Google carry one, and it's
    # minted when the link is first asked for rather than at creation.
    ("users", "login_token", "VARCHAR"),
]

# The tables whose primary key gained `user_id`. A row here that still lacks the
# column means the rebuild migration hasn't run, which `assert_migrated` turns
# into a refusal to serve rather than a stream of confusing query errors.
_REBUILT_TABLES = (
    "watch_history",
    "watch_later",
    "hidden_channels",
    "channel_tags",
    "channel_tag_rejections",
)


async def _apply_column_migrations(conn):
    for table, column, ddl in _COLUMN_MIGRATIONS:
        cols = await conn.execute(text(f"PRAGMA table_info({table})"))
        existing = {row[1] for row in cols}
        if column not in existing:
            await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))


class MigrationRequired(RuntimeError):
    """The schema predates accounts and needs a migration run by hand."""


async def _assert_migrated(conn):
    """Refuse to serve a database that's half-way through the accounts move.

    `create_all` makes missing tables and `_apply_column_migrations` adds missing
    columns, but neither can widen a PRIMARY KEY — SQLite has no syntax for it,
    so those five tables are rebuilt by a script the user runs deliberately, with
    a backup. Starting without it would leave every personal query filtering on a
    column that isn't there: a hundred identical OperationalErrors, and no
    indication of the one thing that fixes them.
    """
    behind = []
    for table in _REBUILT_TABLES:
        rows = await conn.execute(text(f"PRAGMA table_info({table})"))
        cols = {row[1] for row in rows}
        # An empty PRAGMA means the table doesn't exist yet — a fresh install,
        # where create_all is about to build it correctly.
        if cols and "user_id" not in cols:
            behind.append(table)
    if behind:
        raise MigrationRequired(
            "This database predates per-user data. Back up "
            "data/youtube_feed.db, then run:\n"
            "    python -m scripts.migrate_personal_tables\n"
            f"(waiting on: {', '.join(behind)})"
        )


async def init_db():
    async with engine.begin() as conn:
        # WAL lets readers (feed queries) proceed while the background scan writes,
        # so a running/failing update never blocks the locally-cached feed.
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await _assert_migrated(conn)
        await conn.run_sync(Base.metadata.create_all)
        await _apply_column_migrations(conn)