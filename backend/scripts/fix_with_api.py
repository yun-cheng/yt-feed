#!/Users/zeke/personal-youtube-feed/backend/.venv/bin/python
"""Fix view counts + published_at for all videos using YouTube Data API (much faster)."""
import asyncio
import aiosqlite
from datetime import datetime, timezone

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

DB_PATH = "/Users/zeke/personal-youtube-feed/data/youtube_feed.db"

async def fix():
    db = await aiosqlite.connect(DB_PATH)
    cursor = await db.execute("SELECT youtube_id FROM videos")
    all_ids = [r[0] for r in await cursor.fetchall()]
    print(f"Fixing {len(all_ids)} videos via YouTube Data API...")

    # Get OAuth token (personal/J7 brand)
    token_path = "/Users/zeke/.hermes/google_tokens/personal.json"
    import json
    with open(token_path) as f:
        creds = Credentials.from_authorized_user_info(json.load(f))
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        payload = json.loads(creds.to_json())
        payload["type"] = "authorized_user"
        with open(token_path, "w") as f:
            json.dump(payload, f, indent=2)

    youtube = build("youtube", "v3", credentials=creds)
    fixed = 0
    batch_size = 50

    for i in range(0, len(all_ids), batch_size):
        batch = all_ids[i:i+batch_size]
        try:
            resp = youtube.videos().list(
                part="snippet,statistics,contentDetails",
                id=",".join(batch),
            ).execute()

            for item in resp.get("items", []):
                vid = item["id"]
                pub = item["snippet"]["publishedAt"]
                views = int(item["statistics"].get("viewCount", 0))
                likes = int(item["statistics"].get("likeCount", 0))
                duration_str = item["contentDetails"]["duration"]

                # Parse ISO 8601 duration
                dur = 0
                import re
                m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', duration_str)
                if m:
                    h, m_, s = [int(x) if x else 0 for x in m.groups()]
                    dur = h * 3600 + m_ * 60 + s

                await db.execute(
                    """UPDATE videos SET 
                       view_count = ?, like_count = ?, duration_seconds = ?,
                       published_at = ?, last_updated = ?
                       WHERE youtube_id = ?""",
                    (views, likes, dur, pub, datetime.now(timezone.utc).isoformat(), vid)
                )
                fixed += 1

            if (i // batch_size) % 5 == 0:
                await db.commit()
                print(f"  Progress: {min(i+batch_size, len(all_ids))}/{len(all_ids)} (fixed: {fixed})")

        except Exception as e:
            print(f"  Batch error at {i}: {e}")

    await db.commit()
    await db.close()
    print(f"\nDone. Fixed {fixed}/{len(all_ids)} videos.")

asyncio.run(fix())