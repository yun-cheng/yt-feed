"""
Give every personal row an owner.

The one destructive step in the move to accounts. Five tables identify a row by
a YouTube id alone — which stopped being enough the moment two people could watch
the same video — so their PRIMARY KEY has to widen to include `user_id`:

    watch_history          youtube_id  ->  (user_id, youtube_id)
    watch_later            youtube_id  ->  (user_id, youtube_id)
    hidden_channels        channel_id  ->  (user_id, channel_id)
    channel_tags           (channel_id, tag_name)  ->  (user_id, ...)
    channel_tag_rejections (channel_id, tag_name)  ->  (user_id, ...)

SQLite has no `ALTER TABLE ... ALTER PRIMARY KEY`, so each one is rebuilt the
only way there is: create the new shape, copy every row into it, drop the old,
rename. That's why this is a script you run deliberately rather than something
`init_db` does behind you — it rewrites tables holding data you can't get back.

**Back up data/youtube_feed.db first.** Everything is done inside one
transaction, so a failure rolls back rather than leaving half a schema, but a
backup is what makes that a promise rather than a hope.

Every existing row is assigned to **user 1** — the person who was here before
there were accounts. Run scripts/migrate_multiuser.py first if you haven't; this
one refuses to start without a user to hand the rows to.

Safe to run twice: a table that already has `user_id` is skipped.

Run from the backend directory:
    python -m scripts.migrate_personal_tables --dry-run
    python -m scripts.migrate_personal_tables
"""
import asyncio
import sys

from sqlalchemy import text

from app.database import engine

# table -> (new column list with types/constraints, the columns to copy).
# Spelled out rather than derived from the models: a rebuild that reads its
# target from the same place the app does would happily "migrate" a database
# into whatever shape today's code wants, which is how a bad deploy eats data.
REBUILDS = {
    "watch_history": """
        user_id INTEGER NOT NULL,
        youtube_id VARCHAR NOT NULL,
        position_seconds FLOAT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        watched BOOLEAN,
        title VARCHAR,
        channel_id VARCHAR,
        channel_name VARCHAR,
        channel_thumbnail VARCHAR,
        thumbnail_url VARCHAR,
        published_at VARCHAR,
        view_count BIGINT,
        like_count BIGINT,
        is_short BOOLEAN,
        score FLOAT,
        created_at DATETIME,
        updated_at DATETIME,
        PRIMARY KEY (user_id, youtube_id)
    """,
    "watch_later": """
        user_id INTEGER NOT NULL,
        youtube_id VARCHAR NOT NULL,
        title VARCHAR NOT NULL,
        channel_id VARCHAR,
        channel_name VARCHAR,
        channel_thumbnail VARCHAR,
        thumbnail_url VARCHAR,
        duration_seconds INTEGER,
        published_at VARCHAR,
        view_count BIGINT,
        like_count BIGINT,
        score FLOAT,
        created_at DATETIME,
        PRIMARY KEY (user_id, youtube_id)
    """,
    "hidden_channels": """
        user_id INTEGER NOT NULL,
        channel_id VARCHAR NOT NULL,
        created_at DATETIME,
        PRIMARY KEY (user_id, channel_id)
    """,
    "channel_tags": """
        user_id INTEGER NOT NULL,
        channel_id VARCHAR NOT NULL,
        tag_name VARCHAR NOT NULL,
        auto_assigned INTEGER,
        PRIMARY KEY (user_id, channel_id, tag_name)
    """,
    "channel_tag_rejections": """
        user_id INTEGER NOT NULL,
        channel_id VARCHAR NOT NULL,
        tag_name VARCHAR NOT NULL,
        created_at DATETIME,
        PRIMARY KEY (user_id, channel_id, tag_name)
    """,
}


async def _columns(conn, table: str) -> list[str]:
    rows = await conn.execute(text(f"PRAGMA table_info({table})"))
    return [r[1] for r in rows]


async def _count(conn, table: str) -> int:
    return (await conn.execute(text(f"SELECT COUNT(*) FROM {table}"))).scalar_one()


async def _move_user_settings(conn, owner: int, dry_run: bool) -> list[str]:
    """Carry preferences that turned out to be personal into `user_settings`.

    `app_settings` used to hold every switch, because there was one person to
    hold them for. The ones now marked `scope="user"` belong to a row in the
    other table, and left where they are they'd read as unset — so a preference
    someone deliberately turned OFF would come back on, silently.

    The stale row is deleted rather than left as a harmless duplicate: two rows
    claiming the same key is exactly the ambiguity this move exists to end.
    """
    from app.app_settings import SPEC

    user_keys = [s.key for s in SPEC if s.scope == "user"]
    if not user_keys:
        return []

    placeholders = ", ".join(f"'{k}'" for k in user_keys)
    rows = (await conn.execute(text(
        f"SELECT key, value FROM app_settings WHERE key IN ({placeholders})"
    ))).all()
    if not rows:
        return []

    if not dry_run:
        for key, value in rows:
            await conn.execute(
                text("INSERT OR IGNORE INTO user_settings (user_id, key, value) "
                     "VALUES (:u, :k, :v)"),
                {"u": owner, "k": key, "v": value},
            )
        await conn.execute(text(
            f"DELETE FROM app_settings WHERE key IN ({placeholders})"
        ))
    return [r[0] for r in rows]


async def _claim_imports(conn, owner: int, dry_run: bool) -> int:
    """Hand the videos you pasted in to you.

    `imported_videos` was two things at once: the metadata snapshot for a video
    the feed doesn't hold (a cache, shared — one yt-dlp fetch however many people
    paste the same link) and the list of what you imported (personal). The list
    is now `user_imports`, and `source="import"` is what marks the rows that were
    on it. The `source="youtube"` rows are cache and stay unclaimed.
    """
    rows = (await conn.execute(text(
        "SELECT youtube_id, created_at FROM imported_videos WHERE source = 'import'"
    ))).all()
    if not rows:
        return 0
    if not dry_run:
        for youtube_id, created_at in rows:
            await conn.execute(
                text("INSERT OR IGNORE INTO user_imports (user_id, youtube_id, created_at) "
                     "VALUES (:u, :y, :c)"),
                {"u": owner, "y": youtube_id, "c": created_at},
            )
    return len(rows)


async def main(dry_run: bool = False) -> int:
    async with engine.begin() as conn:
        users = await _columns(conn, "users")
        if not users:
            print("No users table. Run `python -m scripts.migrate_multiuser` first.")
            return 1
        owner = (await conn.execute(
            text("SELECT id FROM users ORDER BY id LIMIT 1")
        )).scalar_one_or_none()
        if owner is None:
            print("No user to assign these rows to. Run "
                  "`python -m scripts.migrate_multiuser` first.")
            return 1

        moved = await _move_user_settings(conn, owner, dry_run)
        claimed = await _claim_imports(conn, owner, dry_run)

        pending, done = [], []
        for table in REBUILDS:
            cols = await _columns(conn, table)
            if not cols:
                continue  # fresh install; create_all will build it correctly
            (done if "user_id" in cols else pending).append(table)

        for table in done:
            print(f"  · {table}: already migrated")
        for table in pending:
            print(f"  → {table}: {await _count(conn, table)} row(s) → user {owner}")

        if moved:
            verb = "would move" if dry_run else "✓ moved"
            print(f"  {verb} to user {owner}: {', '.join(moved)}")
        if claimed:
            verb = "would claim" if dry_run else "✓ claimed"
            print(f"  {verb} {claimed} imported video(s) for user {owner}")

        if not pending:
            print("\nNothing else to do.")
            return 0
        if dry_run:
            print(f"\nWould rebuild {len(pending)} table(s). Nothing written.")
            return 0

        # One transaction for all five: a failure halfway through leaves the
        # database exactly as it was rather than three new shapes and two old.
        for table in pending:
            old_cols = await _columns(conn, table)
            copied = ", ".join(old_cols)
            await conn.execute(text(
                f"CREATE TABLE {table}__new ({REBUILDS[table]})"
            ))
            await conn.execute(text(
                f"INSERT INTO {table}__new (user_id, {copied}) "
                f"SELECT {owner}, {copied} FROM {table}"
            ))
            await conn.execute(text(f"DROP TABLE {table}"))
            await conn.execute(text(f"ALTER TABLE {table}__new RENAME TO {table}"))
            print(f"  ✓ {table}: rebuilt, {await _count(conn, table)} row(s)")

    print(f"\nDone. {len(pending)} table(s) rebuilt; every row belongs to user {owner}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(dry_run="--dry-run" in sys.argv)))
