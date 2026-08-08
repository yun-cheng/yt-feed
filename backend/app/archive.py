"""
Deep per-channel history: filling in the back catalogue the daily scan can't see.

The daily scan (`cron_update.scan_channel_videos`) is yt-dlp flat mode — free,
fast, and it only ever sees a channel's newest ~50 uploads. That's the right
tool for keeping the feed fresh and the wrong one for "show me this channel's
2019". This module walks the Data API uploads playlist instead, which is paged
and quota-priced, and it does so under a budget:

- **A cursor per channel.** A page token is self-contained, so the walk resumes
  across runs, restarts, and days. Without it, deepening a channel that already
  holds 8,000 videos would mean re-walking 160 pages to skip what we have.
- **A daily budget.** `quota.archive_budget()` says how much may be spent now;
  the sweep stops when it's gone and picks up after the Pacific-midnight reset.
  A large library takes a few days to fill, and that is fine.
- **Ascending remaining.** Channels owing the least go first, so completion
  arrives as a steadily growing set of finished channels rather than one
  firehose hogging the allowance. Shortest-job-first: it can't make the total
  finish sooner, but it makes almost all of it finish much sooner.

Shorts labelling is deliberately NOT done per page. It's a fixed ~4s yt-dlp call
against the /shorts tab, so paying it per page would cost more than the fetch;
it runs once, when a channel finishes.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from sqlalchemy import func, select

from app import app_settings, quota
from app.database import async_session
from app.models import Channel, Video
from app.youtube_api import (
    ARCHIVE_CEILING,
    QuotaExceeded,
    fetch_channel_video_counts,
    fetch_uploads_page,
    take_quota_delta,
)

YOUTUBE_THUMB = "https://i.ytimg.com/vi/{vid}/mqdefault.jpg"

# Pages per API round-trip batch. Bigger means fewer awaits and the same quota;
# small enough that a budget check still happens often.
PAGES_PER_STEP = 4


async def _flush_quota(archive: bool = True) -> int:
    """Move what youtube_api just spent into the persisted ledger."""
    spent = take_quota_delta()
    await quota.record(spent, archive=archive)
    return spent


async def channel_progress(session, channel: Channel) -> dict:
    """What we hold for a channel versus what there is to hold."""
    held = (await session.execute(
        select(func.count(Video.youtube_id)).where(Video.channel_id == channel.youtube_id)
    )).scalar() or 0
    oldest = (await session.execute(
        select(func.min(Video.published_at)).where(Video.channel_id == channel.youtube_id)
    )).scalar()

    lifetime = channel.lifetime_count
    # The playlist won't page past its ceiling however many videos the channel
    # really has, so promising "all 40,097" would be a promise we can't keep.
    reachable = min(lifetime, ARCHIVE_CEILING) if lifetime else None
    return {
        "held": held,
        "lifetime": lifetime,
        "reachable": reachable,
        "capped_by_api": bool(lifetime and lifetime > ARCHIVE_CEILING),
        "remaining": max(0, reachable - held) if reachable else None,
        "oldest_held": oldest.isoformat() if oldest else None,
        "exhausted": bool(channel.archive_exhausted),
        "started": channel.archive_cursor is not None or bool(channel.archive_exhausted),
    }


async def refresh_lifetime_counts(channel_ids: list[str] | None = None) -> int:
    """Cache channels' lifetime upload counts. ~1 unit per 50 channels.

    Never gated behind `archive_fill_enabled`: it costs 3 units a week for a
    whole library, and without it the UI can't say "3,260 of 8,917" — which is
    the number that makes the fill legible whether or not it's switched on.
    """
    if channel_ids is None:
        async with async_session() as session:
            channel_ids = [r[0] for r in await session.execute(select(Channel.youtube_id))]
    ids = list(channel_ids)
    if not ids:
        return 0
    loop = asyncio.get_event_loop()
    counts = await loop.run_in_executor(None, fetch_channel_video_counts, ids)
    # Recorded against the day but NOT against the archive's share: this is the
    # readout, which runs whether or not the fill is switched on. Charging it to
    # the archive would let a page refresh eat the fetching budget.
    await _flush_quota(archive=False)
    if not counts:
        return 0
    async with async_session() as session:
        for cid, n in counts.items():
            ch = await session.get(Channel, cid)
            if ch:
                ch.lifetime_count = n
        await session.commit()
    return len(counts)


async def _store_uploads(channel_id: str, items: list[dict]) -> list[str]:
    """Insert uploads we don't already have. Returns the new IDs.

    Titles, stats and durations arrive later via `batch_update_stats` — the
    playlist only carries an id and a publish date.
    """
    if not items:
        return []
    ids = [u["youtube_id"] for u in items]
    new_ids: list[str] = []
    async with async_session() as session:
        # One query, not one per video: the walk hands us 50 at a time and a
        # round-trip each would dwarf the fetch it's checking against.
        known = {
            r[0] for r in await session.execute(
                select(Video.youtube_id).where(Video.youtube_id.in_(ids))
            )
        }
        for u in items:
            vid = u["youtube_id"]
            if vid in known:
                continue
            known.add(vid)  # the same page can repeat an id
            pub = u["published_at"]
            session.add(Video(
                youtube_id=vid,
                channel_id=channel_id,
                title="",  # filled by batch_update_stats
                thumbnail_url=YOUTUBE_THUMB.format(vid=vid),
                published_at=pub.replace(tzinfo=None) if pub.tzinfo else pub,
                duration_seconds=0,
                is_short=False,  # corrected by label_shorts when the walk ends
                view_count=0,
                like_count=0,
                last_updated=datetime.now(timezone.utc),
            ))
            new_ids.append(vid)
        await session.commit()
    return new_ids


async def fill_channel(channel_id: str, budget_units: int) -> dict:
    """Walk one channel's uploads until it's exhausted or the budget runs out.

    Returns {"added", "spent", "exhausted", "stopped"} where `stopped` is why we
    came back: "exhausted", "budget", or "quota" (the API refused).
    """
    added: list[str] = []
    spent = 0
    stopped = "budget"
    loop = asyncio.get_event_loop()

    async with async_session() as session:
        channel = await session.get(Channel, channel_id)
        if channel is None:
            return {"added": 0, "spent": 0, "exhausted": False, "stopped": "missing"}
        cursor, exhausted = channel.archive_cursor, bool(channel.archive_exhausted)

    # The budget is spent in PAGES, not in what the counter reports back. One
    # playlistItems page is exactly one unit, so the two agree — but a walk
    # whose stopping condition is a measurement can be talked out of stopping by
    # a bad measurement, and "loops forever against YouTube" is not a failure
    # mode worth leaving open. The ledger still records what was really spent.
    budget_left = budget_units
    while not exhausted and budget_left > 0:
        pages = min(PAGES_PER_STEP, budget_left)
        budget_left -= pages
        try:
            page = await loop.run_in_executor(
                None, fetch_uploads_page, channel_id, cursor, pages
            )
        except QuotaExceeded:
            spent += await _flush_quota()
            stopped = "quota"
            break
        spent += await _flush_quota()

        added += await _store_uploads(channel_id, page["items"])
        cursor, exhausted = page["cursor"], page["exhausted"]

        async with async_session() as session:
            ch = await session.get(Channel, channel_id)
            if ch:
                ch.archive_cursor = cursor
                ch.archive_exhausted = exhausted
                await session.commit()

        if exhausted:
            stopped = "exhausted"
            break
        if not page["items"] and not page["cursor"]:
            break  # nothing came back and nowhere to go — don't spin

    if exhausted:
        stopped = "exhausted"
    return {"added": len(added), "new_ids": added, "spent": spent,
            "pages": budget_units - budget_left, "exhausted": exhausted,
            "stopped": stopped}


async def channels_by_remaining() -> list[tuple[str, int]]:
    """Channels still owing videos, neediest-last: (id, remaining).

    Ordered by how much each has left, ascending — the shortest-job-first rule.
    A channel that has never been walked sorts ahead of one already in progress,
    so a subscription added today isn't stuck behind a three-day firehose.
    """
    async with async_session() as session:
        rows = list((await session.execute(
            select(Channel).where(Channel.archive_exhausted.is_(False))
        )).scalars().all())
        held = dict((await session.execute(
            select(Video.channel_id, func.count(Video.youtube_id)).group_by(Video.channel_id)
        )).all())

    out = []
    for ch in rows:
        reachable = min(ch.lifetime_count, ARCHIVE_CEILING) if ch.lifetime_count else None
        # An unknown lifetime means the count lookup hasn't run: assume there's
        # work rather than skipping the channel forever.
        remaining = max(0, reachable - held.get(ch.youtube_id, 0)) if reachable else 1
        if remaining <= 0:
            continue
        out.append((ch.youtube_id, remaining, ch.archive_cursor is not None))
    out.sort(key=lambda r: (r[2], r[1]))
    return [(cid, rem) for cid, rem, _ in out]


async def library_summary() -> dict:
    """How much of the whole library is still unfetched.

    The number you want before switching the fill on, rather than after. Days
    are an estimate from the daily budget, and deliberately a floor of 1: "about
    a day" is honest, "0 days" reads as "instant".
    """
    async with async_session() as session:
        total_channels = (await session.execute(
            select(func.count(Channel.youtube_id))
        )).scalar() or 0
        # A channel with no cached lifetime count can't be sized yet. Counted
        # separately rather than guessed at, so the total never quietly means
        # "plus an unknown amount more".
        unsized = (await session.execute(
            select(func.count(Channel.youtube_id)).where(
                Channel.lifetime_count.is_(None), Channel.archive_exhausted.is_(False)
            )
        )).scalar() or 0
    queue = await channels_by_remaining()
    # channels_by_remaining stands unsized channels in at 1; don't let that
    # placeholder masquerade as a real video count.
    remaining = sum(r for _cid, r in queue) - unsized
    pending = len(queue)
    # Complete is defined as "not pending", not as `archive_exhausted` — a
    # channel can hold everything reachable without its walk having formally
    # ended, and counting only the flag left those unaccounted for, so the two
    # numbers didn't add up to the total. A summary whose arithmetic is visibly
    # wrong is worse than no summary.
    done = total_channels - pending

    # 1 unit lists 50 videos and 1 unit stats 50, so a unit moves 25 videos.
    per_day = int(quota.DAILY_UNITS * quota.ARCHIVE_SHARE) * 25
    days = max(1, -(-remaining // per_day)) if remaining > 0 else 0

    return {
        "channels_total": total_channels,
        "channels_complete": done,
        "channels_pending": pending,
        "channels_unsized": unsized,
        "videos_remaining": remaining,
        "days_estimate": days,
    }


async def run_archive_fill(budget_units: int | None = None) -> dict:
    """One pass of the budgeted sweep across every channel that still owes videos.

    Stops when the budget is spent, the API refuses, or nothing is left to fetch.
    Idempotent and resumable: every channel's cursor is persisted as it goes, so
    an interrupted pass costs nothing but the page it was on.
    """
    from app.cron_update import batch_update_stats, label_channel_shorts

    budget = budget_units if budget_units is not None else await quota.archive_budget()
    if budget <= 0:
        return {"channels": 0, "added": 0, "spent": 0, "stopped": "budget"}

    await refresh_lifetime_counts()
    budget = min(budget, await quota.archive_budget()) if budget_units is None else budget

    queue = await channels_by_remaining()
    spent = 0
    added_ids: list[str] = []
    touched = 0
    finished: list[str] = []
    stopped = "done"

    for channel_id, _remaining in queue:
        if spent >= budget:
            stopped = "budget"
            break
        # Re-read between channels rather than trusting the value we started
        # with: switching the fill off has to actually stop it, not stop the
        # next one. A sweep can run for many minutes.
        if not await app_settings.get("archive_fill_enabled") and budget_units is None:
            stopped = "disabled"
            break
        result = await fill_channel(channel_id, budget - spent)
        # Charged in pages, for the same reason fill_channel is: the budget has
        # to hold even if the spend counter reads wrong.
        spent += max(result["pages"], result["spent"])
        added_ids += result.get("new_ids", [])
        if result["added"]:
            touched += 1
        if result["exhausted"]:
            finished.append(channel_id)
        if result["stopped"] == "quota":
            stopped = "quota"
            break

    # Stats and Shorts labels, once per pass rather than once per page. Batches
    # are filled across channels so none of them is a partial 50.
    if added_ids:
        try:
            await batch_update_stats(added_ids, ytdlp_fallback=False)
        except QuotaExceeded:
            stopped = "quota"
        await _flush_quota(archive=False)  # stats for the feed, not the archive
    for channel_id in finished:
        await label_channel_shorts(channel_id)

    if added_ids:
        try:
            from app import search_index
            await search_index.index_videos(added_ids)
        except Exception as e:
            print(f"  [search] index skipped: {e}")

    return {"channels": touched, "added": len(added_ids), "spent": spent,
            "finished": len(finished), "stopped": stopped}


async def archive_phase() -> dict | None:
    """The cron's hook. Does nothing at all unless the fill is switched on.

    The switch is an app setting (Settings → Library), not an env var: turning
    it on should be deliberate, but turning it off has to take effect without a
    restart — see app/app_settings.py.
    """
    if not await app_settings.get("archive_fill_enabled"):
        return None
    budget = await quota.archive_budget()
    if budget <= 0:
        print("[archive] no quota budget left today; skipping")
        return None
    print(f"[archive] filling with up to {budget} units...")
    result = await run_archive_fill(budget)
    print(f"[archive] +{result['added']} videos across {result['channels']} channels, "
          f"{result['finished']} finished, ~{result['spent']} units ({result['stopped']})")
    return result
