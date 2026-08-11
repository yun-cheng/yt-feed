"""Bookmarks — moments in a video the user marked with `b` while watching.

Server-side rather than localStorage for the same reason as watch history: the
mark is about the video, not the browser that made it, so it should still be
there on another device (and after a cache clear).

Deliberately thin: the client owns the "press `b` again to remove it" behaviour,
because it already holds the list and can answer instantly. This just stores
rows and hands them back in playback order.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth
from app.database import async_session
from app.models import Bookmark, User

router = APIRouter(prefix="/bookmarks")


async def get_db():
    async with async_session() as session:
        yield session


class BookmarkCreate(BaseModel):
    # A YouTube id, or a LocalVideo id for a file from a local folder — see the
    # model. Anything that identifies a video to the page that plays it.
    video_id: str
    position_seconds: float = 0.0
    note: str = ""


def _serialize(b: Bookmark) -> dict:
    return {
        "id": b.id,
        "video_id": b.video_id,
        "position_seconds": b.position_seconds or 0.0,
        "note": b.note or "",
        "created_at": b.created_at.isoformat() if b.created_at else None,
    }


@router.get("/{video_id}")
async def list_bookmarks(
    video_id: str,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """One video's bookmarks, earliest moment first — the order they're shown and
    stepped through, which is the video's own order, not the order they were made."""
    rows = (await db.execute(
        select(Bookmark)
        .where(Bookmark.user_id == user.id, Bookmark.video_id == video_id)
        .order_by(Bookmark.position_seconds)
    )).scalars().all()
    return [_serialize(b) for b in rows]


@router.post("")
async def add_bookmark(
    p: BookmarkCreate,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    b = Bookmark(
        user_id=user.id,
        video_id=p.video_id,
        position_seconds=max(0.0, p.position_seconds),
        note=p.note.strip(),
        created_at=datetime.utcnow(),
    )
    db.add(b)
    await db.commit()
    return _serialize(b)


@router.delete("/id/{bookmark_id}")
async def remove_bookmark(
    bookmark_id: int,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Prefixed with /id/ so it can't be read as a video id — the GET above takes
    one of those in the same slot, and a bare {bookmark_id} would shadow nothing
    but would leave the two routes looking interchangeable when they aren't."""
    b = await db.get(Bookmark, bookmark_id)
    # Somebody else's bookmark is "no such bookmark" rather than a refusal —
    # a 403 would confirm the id exists, which is more than the asker should learn.
    if b is None or b.user_id != user.id:
        raise HTTPException(status_code=404, detail="No such bookmark")
    await db.execute(delete(Bookmark).where(Bookmark.id == bookmark_id))
    await db.commit()
    return {"status": "ok"}
