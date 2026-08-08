"""
Give nameless history rows their metadata back.

A history row copies its title, channel and stats from whatever the watch page
knew at the time. Open a video the app held no row for — which is what the
extension's "open in YT Feed" button does — and that was nothing, so the row
landed blank and the History page drew an untitled card.

`GET /api/feed/video/{id}` now resolves an unknown video from YouTube and keeps
it, so rows written from here on are fine. This repairs the ones written before,
by asking that same endpoint function: identical lookup order (subscribed video →
imported snapshot → live from YouTube), and no second copy of it to drift.

Run from the backend directory:
    python -m scripts.fix_blank_history          # repair
    python -m scripts.fix_blank_history --dry-run
"""
import asyncio
import sys

from sqlalchemy import or_, select

from app.database import async_session, init_db
from app.models import WatchHistory
from app.routers.feed import get_video

# Copied onto the row; everything else (position, duration, watched) is the
# player's own record of what you did and is never touched here.
FIELDS = (
    "title", "channel_id", "channel_name", "channel_thumbnail",
    "thumbnail_url", "published_at", "view_count", "like_count",
    "is_short", "score",
)


async def main(dry_run: bool = False) -> int:
    await init_db()

    async with async_session() as session:
        blank = (await session.execute(
            select(WatchHistory).where(
                or_(WatchHistory.title == "", WatchHistory.title.is_(None))
            )
        )).scalars().all()
        ids = [row.youtube_id for row in blank]

    if not ids:
        print("No blank history rows — nothing to do.")
        return 0

    print(f"{len(ids)} blank row(s): {', '.join(ids)}")
    if dry_run:
        print("(dry run — nothing written)")
        return 0

    repaired, unresolved = 0, []
    for video_id in ids:
        # A session per video: one unresolvable id shouldn't roll back the rest,
        # and the resolve itself commits the cached row it creates.
        async with async_session() as session:
            meta = await get_video(video_id, session)
            if not meta.get("title"):
                unresolved.append(video_id)
                print(f"  · {video_id}: no metadata (private, deleted, or region-locked)")
                continue

            row = await session.get(WatchHistory, video_id)
            for field in FIELDS:
                if field in meta:
                    setattr(row, field, meta[field])
            await session.commit()
            repaired += 1
            print(f"  ✓ {video_id}: {meta['title'][:60]}")

    print(f"\nRepaired {repaired} of {len(ids)}.")
    if unresolved:
        print(
            f"Still blank: {', '.join(unresolved)} — YouTube won't say what they "
            "were, so the ids are all that's left of them."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(dry_run="--dry-run" in sys.argv)))
