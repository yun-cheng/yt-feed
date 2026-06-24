"""
Feed endpoints — ranked videos grouped by category.
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import Channel, Video
from app.ranking import TimeWindow, rank_videos
from app.categorizer import get_categories, get_channel_groups

router = APIRouter(prefix="/feed")


async def get_db():
    async with async_session() as session:
        yield session


@router.get("")
async def get_feed(
    window: TimeWindow = Query(default=TimeWindow.ONE_WEEK, alias="window"),
    sort: str = Query(default="score", description="score | views | newest | oldest"),
    group: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    """
    Return ranked videos, grouped by category.

    - window: time filter (1w, 2w, 1m, 3m, 6m, 1y)
    - sort: sort mode (score, views, newest, oldest)
    - group: filter to a specific category (omit for all)
    """
    # 1. Load categories + channel-group mapping
    categories = get_categories()
    channel_groups = get_channel_groups()

    # 2. Build {group_name: [channel_ids]}
    groups: dict[str, list[str]] = {}
    for cid, entry in channel_groups.items():
        # entry format: "auto:科技" or "科技"
        group_name = entry.split(":", 1)[-1] if ":" in entry else entry
        groups.setdefault(group_name, []).append(cid)

    # 3. Query videos (fetch more to support lazy loading)
    stmt = select(Video).order_by(Video.published_at.desc()).limit(2000)
    result = await db.execute(stmt)
    all_videos = result.scalars().all()

    # 4. Build channel_id → channel_title + group_name map
    chan_stmt = select(Channel.youtube_id, Channel.title, Channel.group_name)
    chan_result = await db.execute(chan_stmt)
    channel_map = {r.youtube_id: {"title": r.title, "group": r.group_name} for r in chan_result}
    chan_titles = {cid: info["title"] for cid, info in channel_map.items()}

    # 5. Group and rank
    response_groups = []
    uncategorized_videos = []

    for cat in categories:
        name = cat["name"]
        if group and name != group:
            continue

        cids = groups.get(name, [])
        group_videos = [v for v in all_videos if v.channel_id in cids]
        if not group_videos:
            continue

        ranked = rank_videos(group_videos, window, chan_titles, sort=sort)
        response_groups.append({
            "name": name,
            "icon": cat.get("icon", ""),
            "sort_order": cat.get("sort_order", 0),
            "videos": ranked,
        })

    # 6. Uncategorized channels (not in any category group)
    if not group:
        uncategorized = [v for v in all_videos if v.channel_id not in channel_groups]
        if uncategorized:
            ranked_uncat = rank_videos(uncategorized, window, chan_titles, sort=sort)
            if ranked_uncat:
                response_groups.append({
                    "name": "其他",
                    "icon": "📌",
                    "sort_order": 99,
                    "videos": ranked_uncat,
                })

    # 6. Sort groups by sort_order
    response_groups.sort(key=lambda g: g["sort_order"])

    return {
        "categories": categories,
        "groups": response_groups,
        "window": window.value,
    }


@router.get("/statistics")
async def get_feed_statistics(db: AsyncSession = Depends(get_db)):
    """Return total video/channel counts."""
    chan_count = await db.execute(select(Channel).count())
    vid_count = await db.execute(select(Video).count())
    return {
        "channels": chan_count.scalar_one(),
        "videos": vid_count.scalar_one(),
    }