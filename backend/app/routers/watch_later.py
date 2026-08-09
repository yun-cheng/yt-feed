"""Watch Later — server-side saved videos (syncs across devices/browsers)."""

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import WatchLater
# The module rather than the function: `imported` owns avatar-filling, and the
# tests reach in and replace it there. A `from … import` would bind a copy that
# a monkeypatch on the module can no longer reach.
from app.routers import imported

router = APIRouter(prefix="/watch-later")


async def get_db():
    async with async_session() as session:
        yield session


class WatchLaterItem(BaseModel):
    youtube_id: str
    title: str = ""
    channel_id: str = ""
    channel_name: str = ""
    channel_thumbnail: str = ""
    thumbnail_url: str = ""
    duration_seconds: int = 0
    published_at: str = ""
    view_count: int = 0
    like_count: int = 0
    score: float = 0.0


def _serialize(w: WatchLater) -> dict:
    return {
        "youtube_id": w.youtube_id,
        "title": w.title,
        "channel_id": w.channel_id,
        "channel_name": w.channel_name,
        "channel_thumbnail": w.channel_thumbnail or "",
        "thumbnail_url": w.thumbnail_url,
        "duration_seconds": w.duration_seconds,
        "published_at": w.published_at,
        "view_count": w.view_count,
        "like_count": w.like_count,
        "score": w.score,
        # When you saved it — the axis the page both orders and windows by, the
        # same way Imported uses its `created_at` and History its `watched_at`.
        # Publish date is a property of the video; this is the only record of
        # when it became yours.
        "created_at": w.created_at.isoformat() if w.created_at else None,
    }


@router.get("")
async def list_watch_later(db: AsyncSession = Depends(get_db)):
    """Saved videos, most-recently-added first."""
    rows = (await db.execute(
        select(WatchLater).order_by(WatchLater.created_at.desc())
    )).scalars().all()
    return [_serialize(w) for w in rows]


@router.post("")
async def add_watch_later(item: WatchLaterItem, db: AsyncSession = Depends(get_db)):
    """Add a video (idempotent — re-adding an existing one is a no-op)."""
    existing = await db.get(WatchLater, item.youtube_id)
    if existing is None:
        rec = WatchLater(**item.model_dump(), created_at=datetime.utcnow())
        db.add(rec)
        await imported.fill_channel_avatars([rec], db)
        await db.commit()
    return {"status": "ok"}


@router.post("/by-id/{video_id}")
async def add_watch_later_by_id(video_id: str, db: AsyncSession = Depends(get_db)):
    """Save a video we're given nothing but the id of.

    The extension's button (see `extension/open-in-app.js`) is on a YouTube page,
    not in the app: it knows the id and nothing else. Rather than have it scrape
    a title and channel name out of YouTube's markup — which changes — it posts
    the id and the metadata is resolved here, by the same lookup the watch page
    uses. So a video from a subscribed channel costs a row read, and one we've
    never seen is fetched from YouTube once and then cached like any other.

    Returns `saved: false` when the video can't be resolved (private, deleted,
    region-blocked), because saving a nameless row would put an unrenderable
    card on the page.
    """
    existing = await db.get(WatchLater, video_id)
    if existing:
        return {"status": "ok", "saved": True, "already": True, "title": existing.title}

    from app.routers.feed import get_video

    meta = await get_video(video_id, db)
    if not meta.get("title"):
        return {"status": "ok", "saved": False}

    # Only the fields the snapshot holds; `get_video` also returns labels and
    # the channel picture, which belong to the watch page rather than a card.
    item = WatchLaterItem(youtube_id=video_id, **{
        field: meta[field]
        for field in WatchLaterItem.model_fields
        if field != "youtube_id" and meta.get(field) is not None
    })
    rec = WatchLater(**item.model_dump(), created_at=datetime.utcnow())
    db.add(rec)
    await imported.fill_channel_avatars([rec], db)
    await db.commit()
    return {"status": "ok", "saved": True, "already": False, "title": item.title}


@router.delete("/{youtube_id}")
async def remove_watch_later(youtube_id: str, db: AsyncSession = Depends(get_db)):
    await db.execute(delete(WatchLater).where(WatchLater.youtube_id == youtube_id))
    await db.commit()
    return {"status": "ok"}
