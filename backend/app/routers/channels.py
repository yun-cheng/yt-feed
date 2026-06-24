"""
Channel management endpoints — list channels with tags, manage groups.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import async_session
from app.models import Channel, ChannelTag, Video
from app.categorizer import get_categories, get_channel_groups, set_channel_group

router = APIRouter(prefix="/channels")


async def get_db():
    async with async_session() as session:
        yield session


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
    window: str = Query(default="1w", description="Time window: 3d, 1w, 2w, 1m, ..."),
    sort: str = Query(default="score", description="score | views | likes | like% | newest | oldest"),
    limit: int = Query(default=50, description="Max videos"),
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
        .where(Video.channel_id == channel_id)
        .order_by(Video.published_at.desc())
        .limit(2000)
    )
    videos = list(vid_result.scalars().all())

    ranked = rank_videos(videos, TimeWindow(window), {channel_id: channel.title}, sort=sort)

    return {
        "channel": {
            "youtube_id": channel.youtube_id,
            "title": channel.title,
            "description": channel.description or "",
            "thumbnail_url": channel.thumbnail_url,
            "subscriber_count": channel.subscriber_count,
            "tags": tags,
        },
        "window": window,
        "sort": sort,
        "videos": ranked[:limit],
        "total": len(ranked),
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