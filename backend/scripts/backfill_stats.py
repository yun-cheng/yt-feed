"""
Backfill: Use YouTube Data API v3 (videos.list) to get real view counts,
publish dates, durations, and thumbnails for all existing videos.

Fast path: 50 video IDs per request × ~129 requests = done in ~1 minute.

Uses the work OAuth token (~/.hermes/google_token.json) which has
youtube.readonly scope.

Run:  cd /Users/zeke/personal-youtube-feed/backend
      .venv/bin/python -m scripts.backfill_stats
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timezone

import httpx
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from sqlalchemy import select

from app.database import async_session, init_db
from app.models import Video


WORK_TOKEN_PATH = os.path.expanduser("~/.hermes/google_token.json")
SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"]
BATCH_SIZE = 50  # max IDs per videos.list request


def _get_creds() -> Credentials:
    """Load and refresh the work OAuth token."""
    with open(WORK_TOKEN_PATH) as f:
        creds = Credentials.from_authorized_user_info(json.load(f), SCOPES)

    if creds.expired and creds.refresh_token:
        creds.refresh(GoogleRequest())
        print("  [auth] Token refreshed")
    return creds


def _parse_iso8601_duration(duration_str: str) -> int:
    """Convert ISO 8601 duration (PT1H2M3S) to seconds."""
    if not duration_str:
        return 0
    import re
    match = re.match(r"PT?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", duration_str)
    if not match:
        return 0
    h, m, s = [int(g) if g else 0 for g in match.groups()]
    return h * 3600 + m * 60 + s


async def process_batch(
    client: httpx.AsyncClient,
    creds: Credentials,
    video_ids: list[str],
    results: dict,
    batch_num: int,
    total_batches: int,
):
    """Fetch video stats for a batch of IDs and store in results dict."""
    ids_str = ",".join(video_ids)
    resp = await client.get(
        "https://www.googleapis.com/youtube/v3/videos",
        headers={"Authorization": f"Bearer {creds.token}"},
        params={
            "part": "statistics,snippet,contentDetails",
            "id": ids_str,
        },
    )

    if resp.status_code == 403:
        # Token expired mid-flight, refresh and retry once
        creds.refresh(GoogleRequest())
        resp = await client.get(
            "https://www.googleapis.com/youtube/v3/videos",
            headers={"Authorization": f"Bearer {creds.token}"},
            params={
                "part": "statistics,snippet,contentDetails",
                "id": ids_str,
            },
        )

    if resp.status_code != 200:
        print(f"  [batch {batch_num}/{total_batches}] API error {resp.status_code}")
        return

    data = resp.json()
    for item in data.get("items", []):
        vid = item["id"]
        stats = item.get("statistics", {})
        snippet = item.get("snippet", {})
        content = item.get("contentDetails", {})

        published = snippet.get("publishedAt", "")
        if published:
            try:
                pub_dt = datetime.fromisoformat(published.replace("Z", "+00:00"))
            except ValueError:
                pub_dt = None
        else:
            pub_dt = None

        results[vid] = {
            "view_count": int(stats.get("viewCount", 0)),
            "like_count": int(stats.get("likeCount", 0)),
            "comment_count": int(stats.get("commentCount", 0)),
            "published_at": pub_dt,
            "duration_seconds": _parse_iso8601_duration(content.get("duration", "")),
            "thumbnail_url": snippet.get("thumbnails", {}).get("medium", {}).get("url", ""),
        }


async def main():
    print("=" * 60)
    print("Video stats backfill — YouTube Data API v3 (videos.list)")
    print("=" * 60)
    print()

    await init_db()

    # Get all video IDs with zero view count
    async with async_session() as session:
        result = await session.execute(
            select(Video.youtube_id).where(Video.view_count == 0)
        )
        video_ids = [r[0] for r in result.all()]
        total = len(video_ids)

        result = await session.execute(select(Video.youtube_id, Video.view_count))
        all_videos = list(result.all())
        total_all = len(all_videos)
        has_views = sum(1 for _, v in all_videos if v > 0)

    print(f"Total videos in DB: {total_all}")
    print(f"Already have stats: {has_views} ({has_views / max(total_all, 1) * 100:.1f}%)")
    print(f"Need backfill:     {total} ({total / max(total_all, 1) * 100:.1f}%)")
    print(f"Batch size:        {BATCH_SIZE}")
    print(f"API requests:      {(total + BATCH_SIZE - 1) // BATCH_SIZE}")
    print()

    if total == 0:
        print("Nothing to backfill. Exiting.")
        return

    # Process in batches
    creds = _get_creds()
    results: dict[str, dict] = {}
    batches = [video_ids[i:i + BATCH_SIZE] for i in range(0, total, BATCH_SIZE)]
    total_batches = len(batches)

    start = time.monotonic()
    async with httpx.AsyncClient(timeout=30.0) as client:
        for i, batch in enumerate(batches, 1):
            await process_batch(client, creds, batch, results, i, total_batches)
            if i % 10 == 0:
                print(f"  [{i}/{total_batches}] {len(results)} videos fetched so far...")

    elapsed = time.monotonic() - start
    print(f"\n  Fetched {len(results)} video stats in {elapsed:.1f}s ({elapsed / max(len(results), 1) * 1000:.0f}ms/video)")

    # Update DB
    updated = 0
    async with async_session() as session:
        for vid, stats in results.items():
            existing = await session.execute(
                select(Video).where(Video.youtube_id == vid)
            )
            v = existing.scalar_one_or_none()
            if not v:
                continue

            changed = False
            if v.view_count == 0 and stats["view_count"] > 0:
                v.view_count = stats["view_count"]
                changed = True
            if v.like_count == 0 and stats["like_count"] > 0:
                v.like_count = stats["like_count"]
                changed = True

            if stats["published_at"]:
                # Only update if stored date is clearly wrong (within last 24h but video is older)
                now = datetime.now(timezone.utc)
                stored = v.published_at
                if stored.tzinfo is None:
                    stored = stored.replace(tzinfo=timezone.utc)
                hours_stored = (now - stored).total_seconds() / 3600
                actual_age = stats["published_at"]
                if actual_age.tzinfo is None:
                    actual_age = actual_age.replace(tzinfo=timezone.utc)
                hours_actual = (now - actual_age).total_seconds() / 3600
                if hours_stored < 24 and hours_actual > 168:
                    v.published_at = actual_age
                    changed = True
                elif stored != actual_age and v.published_at == stored:
                    # Also update if stored was never set properly
                    v.published_at = actual_age
                    changed = True

            if not v.duration_seconds and stats["duration_seconds"]:
                v.duration_seconds = stats["duration_seconds"]
                changed = True

            if stats["thumbnail_url"]:
                v.thumbnail_url = stats["thumbnail_url"]

            v.last_updated = datetime.now(timezone.utc)
            if changed:
                updated += 1

        await session.commit()

    db_elapsed = time.monotonic() - start
    print(f"  DB update done: {updated} videos had changes")
    print()

    # Final check
    async with async_session() as session:
        result = await session.execute(
            select(Video).where(Video.view_count == 0)
        )
        remaining = len(result.all())

    print("=" * 60)
    print(f"Done in {db_elapsed:.1f}s")
    print(f"  Videos with view_count = 0: {remaining} (was {total})")
    if remaining == 0:
        print("  ✅ All videos now have real stats!")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())