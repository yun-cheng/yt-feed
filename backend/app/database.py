from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

engine = create_async_engine(f"sqlite+aiosqlite:///{settings.db_path}")
async_session = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


# Lightweight additive migrations: create_all makes new TABLES but never adds
# COLUMNS to existing ones. Each entry: (table, column, DDL type + default).
_COLUMN_MIGRATIONS = [
    ("videos", "is_short", "BOOLEAN NOT NULL DEFAULT 0"),
]


async def _apply_column_migrations(conn):
    for table, column, ddl in _COLUMN_MIGRATIONS:
        cols = await conn.execute(text(f"PRAGMA table_info({table})"))
        existing = {row[1] for row in cols}
        if column not in existing:
            await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))


async def init_db():
    async with engine.begin() as conn:
        # WAL lets readers (feed queries) proceed while the background scan writes,
        # so a running/failing update never blocks the locally-cached feed.
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await conn.run_sync(Base.metadata.create_all)
        await _apply_column_migrations(conn)