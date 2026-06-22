#!/Users/zeke/personal-youtube-feed/backend/.venv/bin/python
"""Batch-update view counts and thumbnails for existing videos with missing data."""
import asyncio
import aiosqlite
from datetime import datetime, timezone

import yt_dlp

DB_PATH = "/Users/zeke/personal-youtube-feed/data/youtube_feed.db"
THUMB_TEMPLATE = "https://i.ytimg.com/vi/{vid}/mqdefault.jpg"

async def fetch_and_update():
    db = await aiosqlite.connect(DB_PATH)
    
    # Find videos with 0 views or empty thumbnails
    cursor = await db.execute(
        "SELECT youtube_id FROM videos WHERE view_count = 0 OR thumbnail_url = ''"
    )
    rows = await cursor.fetchall()
    video_ids = [r[0] for r in rows]
    print(f"Found {len(video_ids)} videos needing update")

    if not video_ids:
        print("Nothing to update!")
        await db.close()
        return

    # Fix thumbnails first (deterministic)
    cursor = await db.execute(
        "SELECT youtube_id FROM videos WHERE thumbnail_url = ''"
    )
    no_thumb = [r[0] for r in await cursor.fetchall()]
    for vid in no_thumb:
        await db.execute(
            "UPDATE videos SET thumbnail_url = ? WHERE youtube_id = ?",
            (THUMB_TEMPLATE.format(vid=vid), vid)
        )
    print(f"Fixed thumbnails for {len(no_thumb)} videos")

    # Batch-fetch view counts via yt-dlp (process in batches of 10)
    print(f"Fetching stats for {len(video_ids)} videos...")

    ydl = yt_dlp.YoutubeDL({
        "quiet": True,
        "extract_flat": False,
        "skip_download": True,
        "ignoreerrors": True,
        "no_warnings": True,
    })

    batch_size = 10
    updated = 0
    for i in range(0, len(video_ids), batch_size):
        batch = video_ids[i:i+batch_size]
        urls = [f"https://www.youtube.com/watch?v={vid}" for vid in batch]
        try:
            for url in urls:
                info = ydl.extract_info(url, download=False)
                if info and info.get("id"):
                    await db.execute(
                        """UPDATE videos 
                           SET view_count = ?, like_count = ?, duration_seconds = ?,
                               published_at = ?, last_updated = ?
                           WHERE youtube_id = ?""",
                        (
                            info.get("view_count", 0),
                            info.get("like_count", 0),
                            info.get("duration", 0),
                            datetime.fromtimestamp(info.get("timestamp", 0), tz=timezone.utc).isoformat() if info.get("timestamp") else None,
                            datetime.now(timezone.utc).isoformat(),
                            info["id"]
                        )
                    )
                    updated += 1
        except Exception as e:
            print(f"  Batch error: {e}")
    await db.commit()
    
    await db.close()

asyncio.run(fetch_and_update())