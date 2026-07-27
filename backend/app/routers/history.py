"""Watch history — where you got to in every video you've opened.

Three things read this: the watch page (resume from where you stopped), the
video card (the red progress bar drawn before you hover), and the History page.

Progress is reported by the client every few seconds while a video plays, so
writes here are frequent and small — one upsert keyed by video id, no history
of individual sessions.
"""

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import WatchHistory

router = APIRouter(prefix="/history")

# A video counts as watched at 90% — past that it's credits, outros and end
# cards — or within the last minute, which covers long videos where 90% still
# leaves a quarter of an hour to go.
WATCHED_RATIO = 0.9
WATCHED_TAIL_SECONDS = 60

# Below this, an open isn't a watch: it's a misclick, or a card you bounced off.
# Nothing is recorded until playback passes it, so history stays meaningful.
MIN_POSITION_SECONDS = 5


async def get_db():
    async with async_session() as session:
        yield session


class ProgressUpdate(BaseModel):
    youtube_id: str
    position_seconds: float = 0.0
    duration_seconds: int = 0
    # Metadata snapshot, so the History page can render a card for a video that
    # is no longer (or never was) in the feed.
    title: str = ""
    channel_id: str = ""
    channel_name: str = ""
    channel_thumbnail: str = ""
    thumbnail_url: str = ""
    published_at: str = ""
    view_count: int = 0
    like_count: int = 0
    is_short: bool = False
    score: float = 0.0


def is_watched(position: float, duration: int) -> bool:
    """Whether this position counts as having finished the video."""
    if duration <= 0:
        return False
    return position >= duration * WATCHED_RATIO or duration - position <= WATCHED_TAIL_SECONDS


def _serialize(h: WatchHistory) -> dict:
    """Shaped like a feed VideoItem, plus the playback fields."""
    return {
        "youtube_id": h.youtube_id,
        "title": h.title,
        "channel_id": h.channel_id,
        "channel_name": h.channel_name,
        "channel_thumbnail": h.channel_thumbnail or "",
        "thumbnail_url": h.thumbnail_url,
        "duration_seconds": h.duration_seconds or 0,
        "published_at": h.published_at or "",
        "view_count": h.view_count or 0,
        "like_count": h.like_count or 0,
        "is_short": bool(h.is_short),
        "score": h.score or 0.0,
        "position_seconds": h.position_seconds or 0.0,
        "watched": bool(h.watched),
        "watched_at": h.updated_at.isoformat() if h.updated_at else None,
    }


@router.get("")
async def list_history(db: AsyncSession = Depends(get_db)):
    """Everything you've watched, most recently watched first."""
    rows = (await db.execute(
        select(WatchHistory).order_by(WatchHistory.updated_at.desc())
    )).scalars().all()
    return [_serialize(h) for h in rows]


@router.get("/{video_id}")
async def get_history(video_id: str, db: AsyncSession = Depends(get_db)):
    """One video's progress, for resuming. `{}` if it's never been watched."""
    h = await db.get(WatchHistory, video_id)
    return _serialize(h) if h else {}


@router.post("")
async def report_progress(p: ProgressUpdate, db: AsyncSession = Depends(get_db)):
    """Record how far into a video the player has got (upsert).

    Called on a timer while playing, and once more when the page closes.
    """
    if p.position_seconds < MIN_POSITION_SECONDS:
        return {"status": "ignored"}

    watched = is_watched(p.position_seconds, p.duration_seconds)
    now = datetime.utcnow()
    h = await db.get(WatchHistory, p.youtube_id)
    if h is None:
        h = WatchHistory(youtube_id=p.youtube_id, created_at=now)
        db.add(h)
    h.position_seconds = p.position_seconds
    if p.duration_seconds:
        h.duration_seconds = p.duration_seconds
    # Sticky — reaching the end once is enough; a later rewatch that stops
    # halfway shouldn't mark the video unfinished again.
    h.watched = bool(h.watched) or watched
    h.updated_at = now
    # Refresh the snapshot only from a payload that actually carries one, so a
    # progress ping sent before the watch page resolved its metadata can't blank
    # out a row that already has it.
    if p.title:
        h.title = p.title
        h.channel_id = p.channel_id
        h.channel_name = p.channel_name
        h.channel_thumbnail = p.channel_thumbnail
        h.thumbnail_url = p.thumbnail_url
        h.published_at = p.published_at
        h.view_count = p.view_count
        h.like_count = p.like_count
        h.is_short = p.is_short
        h.score = p.score
    await db.commit()
    return {"status": "ok", "watched": h.watched}


@router.delete("/{video_id}")
async def remove_history(video_id: str, db: AsyncSession = Depends(get_db)):
    await db.execute(delete(WatchHistory).where(WatchHistory.youtube_id == video_id))
    await db.commit()
    return {"status": "ok"}
