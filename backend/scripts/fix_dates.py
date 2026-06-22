#!/Users/zeke/personal-youtube-feed/backend/.venv/bin/python
"""Fix published_at for all videos using yt-dlp full extraction."""
import asyncio
import aiosqlite
from datetime import datetime, timezone

import yt_dlp

DB_PATH = "/Users/zeke/personal-youtube-feed/data/youtube_feed.db"

async def fix():
    db = await aiosqlite.connect(DB_PATH)
    cursor = await db.execute("SELECT youtube_id FROM videos")
    video_ids = [r[0] for r in await cursor.fetchall()]
    print(f"Fixing published_at for {len(video_ids)} videos...")

    ydl = yt_dlp.YoutubeDL({
        "quiet": True,
        "extract_flat": False,
        "skip_download": True,
        "ignoreerrors": True,
        "no_warnings": True,
    })

    batch_size = 10
    fixed = 0
    for i in range(0, len(video_ids), batch_size):
        batch = video_ids[i:i+batch_size]
        for vid in batch:
            try:
                info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
                if info and info.get("timestamp"):
                    pub = datetime.fromtimestamp(info["timestamp"], tz=timezone.utc)
                    await db.execute(
                        "UPDATE videos SET published_at = ?, last_updated = ? WHERE youtube_id = ?",
                        (pub.isoformat(), datetime.now(timezone.utc).isoformat(), vid)
                    )
                    fixed += 1
            except Exception:
                pass
        if (i // batch_size) % 5 == 0:
            await db.commit()
            print(f"  Progress: {min(i+batch_size, len(video_ids))}/{len(video_ids)}")

    await db.commit()
    await db.close()
    print(f"Done. Fixed {fixed} videos.")

asyncio.run(fix())