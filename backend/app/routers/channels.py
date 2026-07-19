"""
Channel management endpoints — list channels with tags, manage groups.
"""

import json

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import async_session
from app.models import Channel, ChannelTag, Video
from app.categorizer import get_categories, get_channel_groups, set_channel_group

router = APIRouter(prefix="/channels")


async def get_db():
    async with async_session() as session:
        yield session


def _labels_json(raw: str | None) -> list[str] | None:
    """Parse a stored JSON label list; None when unbuilt/empty."""
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


@router.get("")
async def list_channels(
    tags: str = Query(default="", description="Comma-separated tag filter (AND logic)"),
    sort: str = Query(default="subs", description="subs | alpha"),
    db: AsyncSession = Depends(get_db),
):
    """List all known channels with tags, subscriber info.

    When `tags` is provided, only returns channels that have ALL specified tags.
    """
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]

    # Sort order
    if sort == "alpha":
        order_col = Channel.title
    else:  # subs (default)
        order_col = Channel.subscriber_count.desc()

    # Base query
    stmt = select(Channel).order_by(order_col)

    # If tag filtering, restrict to channels that match all tags
    if tag_list:
        # Subquery: channel_ids that have ALL requested tags
        subq = (
            select(ChannelTag.channel_id)
            .where(ChannelTag.tag_name.in_(tag_list))
            .group_by(ChannelTag.channel_id)
            .having(func.count(ChannelTag.tag_name) == len(tag_list))
            .subquery()
        )
        stmt = stmt.where(Channel.youtube_id.in_(select(subq.c.channel_id)))

    result = await db.execute(stmt)
    channels = result.scalars().all()

    # Fetch all channel→tag mappings in one query
    tag_result = await db.execute(select(ChannelTag))
    tags_map: dict[str, list[str]] = {}
    for ct in tag_result.scalars().all():
        tags_map.setdefault(ct.channel_id, []).append(ct.tag_name)

    return [
        {
            "youtube_id": ch.youtube_id,
            "title": ch.title,
            "description": ch.description or "",
            "thumbnail_url": ch.thumbnail_url,
            "subscriber_count": ch.subscriber_count,
            "tags": tags_map.get(ch.youtube_id, []),
            "last_video_fetched": ch.last_video_fetched.isoformat() if ch.last_video_fetched else None,
        }
        for ch in channels
    ]


@router.get("/{channel_id}/videos")
async def channel_videos(
    channel_id: str,
    window: str = Query(default="3d", description="Time window: 3d, 1w, 2w, 1m, ..."),
    sort: str = Query(default="likes", description="score | views | likes | like% | newest | oldest"),
    time_mode: str = Query(default="wide", description="narrow | wide"),
    shorts: bool = Query(default=False, description="show Shorts instead of long-form videos"),
    label: str = Query(default="", description="filter to videos carrying this title-label"),
    offset: int = Query(default=0, description="pagination: index into the ranked list"),
    limit: int = Query(default=60, description="pagination: page size"),
    db: AsyncSession = Depends(get_db),
):
    """Get ranked videos for a single channel, same as feed."""
    from app.ranking import TimeWindow, rank_videos

    # Get channel info
    chan_result = await db.execute(
        select(Channel).where(Channel.youtube_id == channel_id)
    )
    channel = chan_result.scalar_one_or_none()
    if not channel:
        raise HTTPException(404, "Channel not found")

    # Get channel tags
    tag_result = await db.execute(
        select(ChannelTag.tag_name).where(ChannelTag.channel_id == channel_id)
    )
    tags = [r[0] for r in tag_result]

    # Get videos
    vid_result = await db.execute(
        select(Video)
        .where(Video.channel_id == channel_id, Video.is_short == shorts)
        .order_by(Video.published_at.desc())
        .limit(2000)
    )
    videos = list(vid_result.scalars().all())

    ranked = rank_videos(videos, TimeWindow(window), {channel_id: channel.title}, sort=sort, time_mode=time_mode, channel_thumbnails={channel_id: channel.thumbnail_url})

    # Attach each video's title-derived labels (null = not labeled yet).
    labels_by_id = {v.youtube_id: v.title_labels for v in videos}
    for item in ranked:
        item["title_labels"] = _labels_json(labels_by_id.get(item["youtube_id"]))

    # Topic chips with counts scoped to THIS view (same window + videos/shorts
    # mode as the list), so a chip's count equals what clicking it shows. Counted
    # over the full windowed set, before the label filter below, so every chip
    # keeps its count while one is selected. A stale-version vocab reads as null,
    # so the page rebuilds it (see the channel-page build trigger).
    from app import video_labels
    built = video_labels.is_current(channel)
    label_vocab = _vocab_counts(built, ranked)
    # Whether this mode has any labeled videos at all, independent of the window —
    # lets the UI say "none in this window" instead of "none for this channel"
    # when the window simply has no matches. (`videos` isn't window-filtered.)
    has_topics = built and any(v.title_labels not in (None, "", "[]") for v in videos)

    # Server-side label filter, applied before pagination so a selected topic
    # returns all its videos in the window regardless of sort or scroll position.
    if label:
        ranked = [item for item in ranked if label in (item["title_labels"] or [])]

    from app.routers.tags import channel_suggestions

    return {
        "channel": {
            "youtube_id": channel.youtube_id,
            "title": channel.title,
            "description": channel.description or "",
            "thumbnail_url": channel.thumbnail_url,
            "subscriber_count": channel.subscriber_count,
            "tags": tags,
            "suggested_tags": await channel_suggestions(db, channel),
            "label_vocab": label_vocab,
            "has_topics": has_topics,
        },
        "window": window,
        "sort": sort,
        "time_mode": time_mode,
        "videos": ranked[offset:offset + limit],
        "total": len(ranked),
        "offset": offset,
    }


# Once a channel has at least this many topics with 2+ videos in view, the chip
# list is rich enough that single-video topics are just noise, so drop them.
# Below it, the list is sparse and singletons are worth keeping.
CHIP_DECLUTTER_AT = 30


def _vocab_counts(built: bool, ranked: list[dict]):
    """Chips as [{name, count}] over `ranked` — the current window + videos/shorts
    view — so each chip's count matches what filtering by it yields.

    Chips are tallied from the videos' actual labels (not the pruned vocabulary),
    so a specific one-off topic (e.g. 紐西蘭 on the only NZ video) can still be a
    chip on a small channel. Adaptive decluttering: only once >=CHIP_DECLUTTER_AT
    topics have 2+ videos in view do we drop the single-video ones; below that the
    list is sparse, so keep everything. Returns None when labels aren't built yet.
    """
    if not built:
        return None
    counts: dict[str, int] = {}
    for item in ranked:
        for lbl in (item.get("title_labels") or []):
            counts[lbl] = counts.get(lbl, 0) + 1
    multi = sum(1 for c in counts.values() if c > 1)
    floor = 2 if multi >= CHIP_DECLUTTER_AT else 1
    return sorted(
        ({"name": name, "count": c} for name, c in counts.items() if c >= floor),
        key=lambda x: (-x["count"], x["name"]),
    )


@router.post("/{channel_id}/labels/build")
async def build_video_labels(channel_id: str, force: bool = False, db: AsyncSession = Depends(get_db)):
    """Kick off (in the background) building this channel's video-label vocabulary.

    No-ops if it's already built (unless `force`) or already running. The channel
    page calls this on first view; poll `.../labels/status` for completion.
    """
    from app import video_labels

    channel = (await db.execute(select(Channel).where(Channel.youtube_id == channel_id))).scalar_one_or_none()
    if not channel:
        raise HTTPException(404, "Channel not found")
    if not force and video_labels.is_current(channel):
        return {"status": "ready"}
    return video_labels.start_build(channel_id, force=force)


@router.get("/{channel_id}/labels/status")
async def video_labels_status(channel_id: str, db: AsyncSession = Depends(get_db)):
    from app import video_labels

    channel = (await db.execute(select(Channel).where(Channel.youtube_id == channel_id))).scalar_one_or_none()
    if not channel:
        raise HTTPException(404, "Channel not found")
    return {
        "building": video_labels.is_building(channel_id),
        "built": video_labels.is_current(channel),
    }


class AssignLabelsBody(BaseModel):
    video_ids: list[str] = []


@router.post("/{channel_id}/labels/assign")
async def assign_video_labels(channel_id: str, body: AssignLabelsBody, db: AsyncSession = Depends(get_db)):
    """Label the given (rendered) videos against the fixed vocabulary.

    Returns {video_id: [labels]} for those it labeled. No-ops until the
    vocabulary exists, so the page builds it first.
    """
    from app import video_labels

    labeled = await video_labels.assign_labels(db, channel_id, body.video_ids[:200])
    return {"labels": labeled}


@router.post("/{channel_id}/backfill")
async def backfill_channel_history(
    channel_id: str,
    years: float = Query(default=1.0, description="how far back to fetch; <=0 = entire history"),
    db: AsyncSession = Depends(get_db),
):
    """Fetch older videos for a channel via the date-aware uploads pager.

    Adds any uploads from the last `years` years (or the whole history when
    `years<=0`) that aren't stored yet, then fills their stats. Idempotent —
    re-running only adds what's missing. This is the primitive a "load more
    history" UI action can call with whatever depth the user picks.
    """
    from datetime import datetime, timezone, timedelta

    from app.cron_update import backfill_channel, batch_update_stats

    channel = (
        await db.execute(select(Channel).where(Channel.youtube_id == channel_id))
    ).scalar_one_or_none()
    if not channel:
        raise HTTPException(404, "Channel not found")

    since = None if years <= 0 else datetime.now(timezone.utc) - timedelta(days=365 * years)
    new_ids = await backfill_channel(channel, since)
    await batch_update_stats(new_ids, ytdlp_fallback=True)
    if new_ids:
        try:
            from app import search_index
            await search_index.reindex_all()
        except Exception:
            pass

    return {
        "channel": channel.title,
        "since": since.isoformat() if since else "all",
        "added": len(new_ids),
    }


@router.post("/{channel_id}/group")
async def set_group(channel_id: str, group_name: str):
    """Manually assign a channel to a group."""
    all_groups = get_categories()
    valid_names = {c["name"] for c in all_groups}
    if group_name not in valid_names:
        raise HTTPException(400, f"Invalid group. Valid: {', '.join(valid_names)}")

    set_channel_group(channel_id, group_name, auto=False)
    return {"status": "ok", "channel_id": channel_id, "group": group_name}


@router.post("/auto-categorize")
async def auto_categorize(db: AsyncSession = Depends(get_db)):
    """Run auto-categorization on all channels."""
    from app.categorizer import auto_categorize as _auto_cat

    result = await db.execute(select(Channel))
    channels_data = result.scalars().all()
    channels_list = [
        {"youtube_id": ch.youtube_id, "title": ch.title, "description": ""}
        for ch in channels_data
    ]
    groups = _auto_cat(channels_list)
    return {"status": "ok", "groups": {k: len(v) for k, v in groups.items()}}