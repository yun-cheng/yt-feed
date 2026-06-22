"""
Channel management endpoints — list channels, manage groups.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import Channel
from app.categorizer import get_categories, get_channel_groups, set_channel_group

router = APIRouter(prefix="/channels")


async def get_db():
    async with async_session() as session:
        yield session


@router.get("")
async def list_channels(db: AsyncSession = Depends(get_db)):
    """List all known channels with their current group assignment."""
    result = await db.execute(select(Channel).order_by(Channel.title))
    channels = result.scalars().all()
    channel_groups = get_channel_groups()

    return [
        {
            "youtube_id": ch.youtube_id,
            "title": ch.title,
            "thumbnail_url": ch.thumbnail_url,
            "subscriber_count": ch.subscriber_count,
            "group": channel_groups.get(ch.youtube_id, ""),
        }
        for ch in channels
    ]


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