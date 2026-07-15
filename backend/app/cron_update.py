"""
Cron job: fetch latest videos for all channels and update DB.

Uses a hybrid approach:
  Phase 1 — yt-dlp flat mode (fast) to scan channels and get video IDs
  Phase 2 — YouTube Data API (batch, 50/request) to fetch real stats

This avoids yt-dlp's slow JS challenge solvers from full extraction.

Run:  cd /Users/zeke/personal-youtube-feed/backend
      source .venv/bin/activate
      python -m app.cron_update
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from app.database import async_session, init_db
from app.models import Channel, Video
from app.fetcher import fetch_latest_videos, fetch_video_details
from app.youtube_api import batch_fetch_video_stats, get_quota_used


YOUTUBE_THUMB = "https://i.ytimg.com/vi/{vid}/mqdefault.jpg"


def _publication_time(entry: dict) -> datetime:
    """Extract publication time from a yt-dlp entry (flat-mode fallback)."""
    ts = entry.get("published_at") or entry.get("timestamp")
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    return datetime.now(timezone.utc)


async def scan_channel_videos(
    channel: Channel,
    since: datetime | None = None,
) -> list[str]:
    """
    Scan a channel's latest videos using yt-dlp flat mode (fast).
    Upserts into DB with whatever stats are available.
    Returns list of NEWLY INSERTED video IDs (need stats via API).
    """
    url = f"https://www.youtube.com/channel/{channel.youtube_id}"
    # Flat mode is fast — no JS challenges, no format extraction.
    # Shorts live on a separate tab, so scan both. Videos first, then shorts:
    # if a video somehow appears in both, the first-seen (long-form) wins.
    videos_data = fetch_latest_videos(url, max_results=50, since=since, detailed=False)
    videos_data += fetch_latest_videos(url, max_results=50, since=since, detailed=False, tab="shorts")

    if not videos_data:
        return []

    new_ids = []
    seen: set[str] = set()
    async with async_session() as session:
        for v in videos_data:
            pub = _publication_time(v)
            vid = v.get("youtube_id")
            if not vid or vid in seen:
                continue
            seen.add(vid)

            existing = await session.execute(
                select(Video).where(Video.youtube_id == vid)
            )
            exists = existing.scalar_one_or_none()
            thumb = v.get("thumbnail_url") or YOUTUBE_THUMB.format(vid=vid)
            duration = v.get("duration_seconds", 0)
            is_short = bool(v.get("is_short"))

            if exists:
                # Update thumbnail/duration if missing, but NOT view_count
                # (view_count will come from YouTube API). Do NOT touch last_updated:
                # it tracks when STATS were last refreshed, and the stale-refresh phase
                # relies on it. Bumping it here (without refreshing stats) would make
                # the video look fresh and starve the stats refresh — freezing counts.
                if not exists.thumbnail_url:
                    exists.thumbnail_url = thumb
                if not exists.duration_seconds and duration:
                    exists.duration_seconds = duration
                # Backfill the shorts flag on rows that predate this column.
                if is_short and not exists.is_short:
                    exists.is_short = True
            else:
                session.add(Video(
                    youtube_id=vid,
                    channel_id=channel.youtube_id,
                    title=v.get("title", ""),
                    thumbnail_url=thumb,
                    published_at=pub,
                    duration_seconds=duration,
                    is_short=is_short,
                    view_count=0,
                    like_count=0,
                    last_updated=datetime.now(timezone.utc),
                ))
                new_ids.append(vid)

        channel.last_video_fetched = datetime.now(timezone.utc)
        await session.commit()

    return new_ids


async def batch_update_stats(new_ids: list[str], ytdlp_fallback: bool = False):
    """
    Batch-fetch real stats via YouTube Data API and update DB.

    When `ytdlp_fallback` is set, any IDs the Data API didn't return (e.g. the
    OAuth token is expired/revoked) are fetched via yt-dlp instead — slower, but
    it keeps stats flowing without the API. Reserved for small sets (new videos);
    the large stale-refresh set skips it to avoid a very slow run.
    """
    if not new_ids:
        return

    stats = batch_fetch_video_stats(new_ids)

    if ytdlp_fallback:
        missing = [vid for vid in new_ids if vid not in stats]
        if missing:
            loop = asyncio.get_event_loop()
            details = await loop.run_in_executor(None, fetch_video_details, missing)
            for d in details:
                stats[d["youtube_id"]] = {
                    "view_count": d.get("view_count", 0) or 0,
                    "like_count": d.get("like_count", 0) or 0,
                    "published_at": d.get("published_at"),
                    "duration_seconds": d.get("duration_seconds", 0) or 0,
                    # yt-dlp details don't carry these — leave existing values alone
                    "title": None,
                    "thumbnail_url": None,
                }

    if not stats:
        return

    updated = 0
    async with async_session() as session:
        for vid, s in stats.items():
            existing = await session.execute(
                select(Video).where(Video.youtube_id == vid)
            )
            v = existing.scalar_one_or_none()
            if not v:
                continue

            if s.get("title"):
                v.title = s["title"]
            v.view_count = s["view_count"]
            v.like_count = s["like_count"]
            if s["published_at"]:
                v.published_at = s["published_at"]
            if s["duration_seconds"]:
                v.duration_seconds = s["duration_seconds"]
            if s["thumbnail_url"]:
                v.thumbnail_url = s["thumbnail_url"]
            v.last_updated = datetime.now(timezone.utc)
            updated += 1

        await session.commit()

    if updated:
        print(f"  [stats] YouTube API: {updated} videos updated")


async def run_update():
    """Main cron task: update all channels and batch-fetch stats."""
    await init_db()

    async with async_session() as session:
        result = await session.execute(select(Channel))
        channels = result.scalars().all()

    # Phase 1: Scan all channels with yt-dlp flat mode (fast)
    all_new_ids: list[str] = []
    total = 0
    start = datetime.now(timezone.utc)

    print(f"Scanning {len(channels)} channels (yt-dlp flat mode)...")
    for ch in channels:
        since = None
        if ch.last_video_fetched:
            since = ch.last_video_fetched - timedelta(hours=12)

        try:
            new_ids = await scan_channel_videos(ch, since=since)
            count = len(new_ids)
            all_new_ids.extend(new_ids)
            total += count
            if count > 0:
                print(f"  [{ch.title[:30]:30s}] +{count:3d} new")
        except Exception as e:
            print(f"  [ERROR] {ch.title[:30]:30s}: {e}")

    scan_elapsed = (datetime.now(timezone.utc) - start).total_seconds()
    print(f"\nPhase 1 done: {total} new videos found in {scan_elapsed:.0f}s")

    # Phase 2: Batch-fetch stats via YouTube API for new videos (yt-dlp fallback
    # so newly-added videos still get real counts if the Data API is unavailable).
    if all_new_ids:
        print(f"Fetching stats for {len(all_new_ids)} new videos via YouTube API...")
        await batch_update_stats(all_new_ids, ytdlp_fallback=True)
        print(f"  API quota used: ~{get_quota_used()} units")
    else:
        print("No new videos to update.")

    # Phase 3: Age-based stale video refresh
    #   published < 1d  AND last_updated > 15m → refresh
    #   published < 3d  AND last_updated > 1h  → refresh
    #   published < 1w  AND last_updated > 6h  → refresh
    #   published < 1m  AND last_updated > 24h → refresh
    #   published < 3m  AND last_updated > 3d  → refresh
    #   published < 6m  AND last_updated > 7d  → refresh
    #   older videos → never refresh (stats stable)
    now = datetime.now(timezone.utc)
    age_rules: list[tuple[timedelta, timedelta]] = [
        (timedelta(days=1),    timedelta(minutes=15)),
        (timedelta(days=3),    timedelta(hours=1)),
        (timedelta(days=7),    timedelta(hours=6)),
        (timedelta(days=30),   timedelta(hours=24)),
        (timedelta(days=90),   timedelta(days=3)),
        (timedelta(days=180),  timedelta(days=7)),
    ]

    stale_ids: set[str] = set()
    async with async_session() as session:
        # Build OR query: (age < X AND last_updated_age > Y) for each rule
        from sqlalchemy import or_
        conditions = []
        for max_age, max_stale in age_rules:
            published_cutoff = now - max_age
            stale_cutoff = now - max_stale
            conditions.append(
                (Video.published_at >= published_cutoff) &
                (Video.last_updated < stale_cutoff)
            )
        if conditions:
            result = await session.execute(
                select(Video.youtube_id).where(or_(*conditions)).limit(2000)
            )
            stale_ids = {r[0] for r in result}

    if stale_ids:
        stale_list = list(stale_ids)
        print(f"Phase 3: {len(stale_list)} stale videos need stats refresh")
        # Process in batches of 50 to keep quota usage low
        for i in range(0, len(stale_list), 250):
            batch = stale_list[i:i + 250]
            await batch_update_stats(batch)
            print(f"  refreshed {min(i + 250, len(stale_list))}/{len(stale_list)}")
        print(f"  Total API quota: ~{get_quota_used()} units")
    else:
        print("No stale videos to refresh.")

    print(f"\nDone. {total} new videos across {len(channels)} channels.")

    # Keep the search index current with the freshly-updated titles/stats.
    try:
        from app import search_index
        counts = await search_index.reindex_all()
        print(f"  [search] reindexed {counts['videos']} videos, {counts['channels']} channels")
    except Exception as e:
        print(f"  [search] reindex skipped: {e}")


if __name__ == "__main__":
    asyncio.run(run_update())