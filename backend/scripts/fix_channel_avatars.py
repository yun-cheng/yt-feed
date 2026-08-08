"""
Fill in missing uploader avatars on the snapshot tables.

Imported and history rows each carry their own copy of the uploader's picture,
snapshotted when the row was written. That copy came from the yt-dlp extraction,
which never carries one: a VIDEO extraction's `thumbnails` are that video's
frames, ids "0".."41", with no avatar among them. So every row written this way
has had a blank avatar and drawn the fallback initial instead.

New rows now get theirs from `fill_channel_avatars` (subscribed channels for
free, one API unit per 50 for the rest). This repairs the ones already written,
through that same function.

Run from the backend directory:
    python -m scripts.fix_channel_avatars
    python -m scripts.fix_channel_avatars --dry-run
"""
import asyncio
import sys

from sqlalchemy import or_, select

from app.database import async_session, init_db
from app.models import ImportedVideo, WatchHistory
from app.routers.imported import fill_channel_avatars
from app.youtube_api import get_quota_used

TABLES = (("imported", ImportedVideo), ("history", WatchHistory))


async def main(dry_run: bool = False) -> int:
    await init_db()
    before = get_quota_used()
    total = 0

    for label, model in TABLES:
        async with async_session() as session:
            rows = (await session.execute(
                select(model).where(
                    or_(model.channel_thumbnail == "", model.channel_thumbnail.is_(None))
                )
            )).scalars().all()
            if not rows:
                print(f"{label}: nothing missing")
                continue

            channels = {r.channel_id for r in rows if r.channel_id}
            print(f"{label}: {len(rows)} row(s) across {len(channels)} channel(s)")
            if dry_run:
                continue

            await fill_channel_avatars(rows, session)
            filled = sum(1 for r in rows if r.channel_thumbnail)
            await session.commit()
            total += filled
            print(f"  filled {filled} of {len(rows)}")

    if dry_run:
        print("(dry run — nothing written)")
        return 0

    print(f"\nFilled {total} row(s); spent {get_quota_used() - before} quota unit(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(dry_run="--dry-run" in sys.argv)))
