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

from app import app_settings, auth, receipts
from app.database import async_session
from app.models import User, WatchHistory

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
    # A live broadcast: the position is recorded, but it can't mean "finished"
    # — see report_progress. The client decides this: it can see the player, and
    # liveness is a property of the moment rather than of the video.
    live: bool = False
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
async def list_history(
    user: User = Depends(auth.account), db: AsyncSession = Depends(get_db)
):
    """Everything you've watched, most recently watched first."""
    rows = (await db.execute(
        select(WatchHistory)
        .where(WatchHistory.user_id == user.id)
        .order_by(WatchHistory.updated_at.desc())
    )).scalars().all()
    return [_serialize(h) for h in rows]


@router.get("/{video_id}")
async def get_history(
    video_id: str,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """One video's progress, for resuming. `{}` if it's never been watched."""
    h = await db.get(WatchHistory, (user.id, video_id))
    return _serialize(h) if h else {}


@router.post("")
async def report_progress(
    p: ProgressUpdate,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Record how far into a video the player has got (upsert).

    Called on a timer while playing, and once more when the page closes.
    """
    if p.position_seconds < MIN_POSITION_SECONDS:
        return {"status": "ignored"}

    # A broadcast's position is stored like any other — it means the same thing,
    # this far in from the start of the stream — but it can never mark the video
    # finished. Watching live puts the play head at the "end" by definition, so
    # `is_watched` would say yes to a stream you joined ten seconds ago. Once it
    # has aired, the same id reports as an ordinary recording and this decides
    # normally.
    watched = False if p.live else is_watched(p.position_seconds, p.duration_seconds)
    now = datetime.utcnow()
    h = await db.get(WatchHistory, (user.id, p.youtube_id))
    if h is None:
        h = WatchHistory(user_id=user.id, youtube_id=p.youtube_id, created_at=now)
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


class ProgressById(BaseModel):
    position_seconds: float = 0.0
    duration_seconds: int = 0


@router.post("/by-id/{video_id}")
async def report_progress_by_id(
    video_id: str,
    p: ProgressById,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Progress from a caller that knows the play head and nothing else.

    The extension reports what you watch on youtube.com itself (see
    `extension/open-in-app.js`), and it is on YouTube's page rather than in the
    app: it has a video id and a `<video>` element. The same argument as
    `add_watch_later_by_id` applies — the metadata is resolved here instead of
    scraped out of markup that changes, and YouTube gives a content script no
    reliable channel id anyway. So a video from a channel we hold costs a row
    read, and one we've never seen is fetched once and cached like any other.

    Only looked up while the row still has no snapshot, because this is called
    every ten seconds of playback and the answer can't change.

    The `youtube_history_sync` setting is checked here as well as in the
    extension, which is what makes turning it off take effect at once: the
    extension holds the flag for up to a minute, so a report already on its way
    when you flip the switch has to be refused rather than written.
    """
    if not await app_settings.get("youtube_history_sync", user.id):
        return {"status": "off"}

    if p.position_seconds < MIN_POSITION_SECONDS:
        return {"status": "ignored"}

    snapshot: dict = {}
    existing = await db.get(WatchHistory, (user.id, video_id))
    if existing is None or not existing.title:
        from app.routers.feed import get_video

        meta = await get_video(video_id, db)
        snapshot = {
            field: meta[field]
            for field in ProgressUpdate.model_fields
            if field not in ("youtube_id", "position_seconds")
            and meta.get(field) is not None
        }

    # The player's own duration is authoritative and wins; the resolved one is
    # there for the case it can't be read (a live stream reports none).
    resolved_duration = int(snapshot.pop("duration_seconds", 0) or 0)
    duration = p.duration_seconds or resolved_duration

    return await report_progress(
        ProgressUpdate(
            youtube_id=video_id,
            **snapshot,
            position_seconds=p.position_seconds,
            duration_seconds=duration,
        ),
        user,
        db,
    )


@router.delete("/{video_id}")
async def remove_history(
    video_id: str,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Forget a video, and hand back what was forgotten.

    The `removed` row is a RECEIPT: it's the whole row as the History page saw
    it, and `POST /restore` takes it back. That's what lets the UI offer Undo
    without holding a shadow copy of the row it just deleted — and it's why the
    resume point and the "Watched" badge survive a misclick, which re-reporting
    progress could never restore (a 30-second position doesn't imply a video you
    had already finished).
    """
    h = await db.get(WatchHistory, (user.id, video_id))
    if h is None:
        return {"status": "ok", "removed": None}
    receipt = _serialize(h)
    await db.execute(delete(WatchHistory).where(
        WatchHistory.user_id == user.id, WatchHistory.youtube_id == video_id
    ))
    await db.commit()
    return {"status": "ok", "removed": receipt}


class HistoryRestore(ProgressUpdate):
    """A removal's receipt, back again. `ProgressUpdate` plus the two fields
    that are read off the row rather than reported by a player."""

    watched: bool = False
    # When it was last watched, so an undone removal goes back to its place in
    # the list instead of to the top of it.
    watched_at: str = ""


@router.post("/restore")
async def restore_history(
    p: HistoryRestore,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Put a removed row back exactly as it was — the undo of remove_history.

    Verbatim, and none of `report_progress`'s judgement: no MIN_POSITION floor
    (the row cleared it once already), and `watched` is taken rather than
    recomputed.

    A row that exists again is left alone. Between the removal and the undo you
    can have opened the video, and that newer position is the true one — there
    is no sense in which undoing a delete should rewind where you are now.
    """
    if await db.get(WatchHistory, (user.id, p.youtube_id)) is not None:
        return {"status": "ok", "restored": False}

    watched_at = receipts.stamp_or_now(p.watched_at)
    h = WatchHistory(
        user_id=user.id,
        youtube_id=p.youtube_id,
        position_seconds=p.position_seconds,
        duration_seconds=p.duration_seconds,
        watched=p.watched,
        title=p.title,
        channel_id=p.channel_id,
        channel_name=p.channel_name,
        channel_thumbnail=p.channel_thumbnail,
        thumbnail_url=p.thumbnail_url,
        published_at=p.published_at,
        view_count=p.view_count,
        like_count=p.like_count,
        is_short=p.is_short,
        score=p.score,
        created_at=watched_at,
        updated_at=watched_at,
    )
    db.add(h)
    await db.commit()
    return {"status": "ok", "restored": True}
