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
from app.youtube_api import batch_fetch_video_stats, fetch_uploads_since, get_quota_used


YOUTUBE_THUMB = "https://i.ytimg.com/vi/{vid}/mqdefault.jpg"

# How many Shorts to pull from the /shorts tab when labelling a backfill. Shorts
# have no Data API playlist of their own, so we flag uploads as Shorts by tab
# membership. Shorts older than this cap fall back to long-form (rare tail).
SHORTS_LABEL_CAP = 500

# Default history depth for a channel's first-ever scan.
BACKFILL_WINDOW = timedelta(days=365)


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

        # `channel` was loaded in another (now-closed) session, so it's detached
        # here — mutating it wouldn't persist. Update the row attached to THIS
        # session instead, and mirror it back onto the passed-in object.
        now_ts = datetime.now(timezone.utc)
        ch_row = await session.get(Channel, channel.youtube_id)
        if ch_row:
            ch_row.last_video_fetched = now_ts
        channel.last_video_fetched = now_ts
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


async def backfill_channel(channel: Channel, since: datetime | None) -> list[str]:
    """Insert a channel's uploads back to `since` (None = entire history).

    Uses the Data API uploads playlist (date-accurate, so it covers a full year
    even for firehose channels — the flat scan can't). Only inserts videos not
    already stored; Shorts are flagged via the /shorts tab. Returns the newly
    inserted IDs so the caller can run `batch_update_stats` to fill in
    titles/stats/durations. Does NOT touch `last_video_fetched`.

    Shared by the first-scan deep fetch and the on-demand "fetch older" endpoint.
    """
    loop = asyncio.get_event_loop()
    uploads = await loop.run_in_executor(
        None, fetch_uploads_since, channel.youtube_id, since
    )
    if not uploads:
        return []

    # Flag which of these uploads are Shorts (separate tab; no Data API listing).
    url = f"https://www.youtube.com/channel/{channel.youtube_id}"
    shorts_data = await loop.run_in_executor(
        None,
        lambda: fetch_latest_videos(
            url, max_results=SHORTS_LABEL_CAP, detailed=False, tab="shorts"
        ),
    )
    short_ids = {v["youtube_id"] for v in shorts_data if v.get("youtube_id")}

    new_ids: list[str] = []
    async with async_session() as session:
        for u in uploads:
            vid = u["youtube_id"]
            existing = (
                await session.execute(select(Video).where(Video.youtube_id == vid))
            ).scalar_one_or_none()
            if existing:
                # Correct a previously mislabelled Short if the tab now shows it.
                if vid in short_ids and not existing.is_short:
                    existing.is_short = True
                continue
            session.add(Video(
                youtube_id=vid,
                channel_id=channel.youtube_id,
                title="",  # filled by batch_update_stats
                thumbnail_url=YOUTUBE_THUMB.format(vid=vid),
                published_at=u["published_at"],
                duration_seconds=0,
                is_short=vid in short_ids,
                view_count=0,
                like_count=0,
                last_updated=datetime.now(timezone.utc),
            ))
            new_ids.append(vid)
        await session.commit()

    return new_ids


async def backfill_all_channels(since: datetime | None) -> dict:
    """One-time helper: backfill every channel to `since`, then fetch stats.

    Idempotent — only inserts videos not already stored. Used to give existing
    high-volume channels their missing history after the date-aware backfill
    landed. Reindexes search at the end.
    """
    await init_db()
    async with async_session() as session:
        channels = list((await session.execute(select(Channel))).scalars().all())

    all_new: list[str] = []
    for ch in channels:
        try:
            new_ids = await backfill_channel(ch, since)
            all_new.extend(new_ids)
            if new_ids:
                print(f"  [{ch.title[:30]:30s}] +{len(new_ids):4d} backfilled")
        except Exception as e:
            print(f"  [ERROR] {ch.title[:30]:30s}: {e}")

    if all_new:
        print(f"Fetching stats for {len(all_new)} backfilled videos...")
        await batch_update_stats(all_new, ytdlp_fallback=True)
        try:
            from app import search_index
            await search_index.reindex_all()
        except Exception as e:
            print(f"  [search] reindex skipped: {e}")

    print(f"Backfill done: {len(all_new)} videos across {len(channels)} channels; "
          f"~{get_quota_used()} quota units")
    return {"added": len(all_new), "channels": len(channels)}


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
        try:
            if ch.last_video_fetched is None:
                # First time we've seen this channel. The cheap flat scan gets
                # recent videos + Shorts labels (and works without the Data API);
                # the date-aware backfill then fills a full year of history.
                new_ids = await scan_channel_videos(ch, since=None)
                new_ids += await backfill_channel(ch, since=start - BACKFILL_WINDOW)
            else:
                since = ch.last_video_fetched - timedelta(hours=12)
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