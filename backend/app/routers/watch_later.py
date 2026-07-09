"""Watch Later — server-side saved videos (syncs across devices/browsers)."""

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import WatchLater

router = APIRouter(prefix="/watch-later")


async def get_db():
    async with async_session() as session:
        yield session


class WatchLaterItem(BaseModel):
    youtube_id: str
    title: str = ""
    channel_id: str = ""
    channel_name: str = ""
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
        "thumbnail_url": w.thumbnail_url,
        "duration_seconds": w.duration_seconds,
        "published_at": w.published_at,
        "view_count": w.view_count,
        "like_count": w.like_count,
        "score": w.score,
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
        db.add(WatchLater(**item.model_dump(), created_at=datetime.utcnow()))
        await db.commit()
    return {"status": "ok"}


@router.delete("/{youtube_id}")
async def remove_watch_later(youtube_id: str, db: AsyncSession = Depends(get_db)):
    await db.execute(delete(WatchLater).where(WatchLater.youtube_id == youtube_id))
    await db.commit()
    return {"status": "ok"}
