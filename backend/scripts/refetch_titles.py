"""
Force re-fetch all video metadata (title, stats, duration, thumbnail) using zh-TW localization.

Run from the backend directory:
    python -m scripts.refetch_titles
"""
import asyncio
from datetime import datetime, timezone

from sqlalchemy import select

from app.database import async_session, init_db
from app.models import Video
from app.youtube_api import batch_fetch_video_stats, clear_cache, get_quota_used


async def main():
    await init_db()
    async with async_session() as session:
        result = await session.execute(select(Video.youtube_id))
        all_ids = [r[0] for r in result]

    print(f"Found {len(all_ids)} videos to re-fetch...")
    clear_cache()  # bypass the 1-hour dedup cache

    updated = 0
    for i in range(0, len(all_ids), 50):
        batch = all_ids[i:i + 50]
        stats = batch_fetch_video_stats(batch)
        async with async_session() as session:
            for vid, s in stats.items():
                result = await session.execute(select(Video).where(Video.youtube_id == vid))
                v = result.scalar_one_or_none()
                if not v:
                    continue
                if s.get("title"):
                    v.title = s["title"]
                v.view_count = s["view_count"]
                v.like_count = s["like_count"]
                if s.get("published_at"):
                    v.published_at = s["published_at"]
                if s.get("duration_seconds"):
                    v.duration_seconds = s["duration_seconds"]
                if s.get("thumbnail_url"):
                    v.thumbnail_url = s["thumbnail_url"]
                v.last_updated = datetime.now(timezone.utc)
                updated += 1
            await session.commit()
        print(f"  {min(i + 50, len(all_ids))}/{len(all_ids)} processed, {updated} videos updated")

    print(f"\nDone. {updated} videos updated. API quota used: ~{get_quota_used()} units")


if __name__ == "__main__":
    asyncio.run(main())
