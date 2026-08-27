"""Marks on the play head: bookmarks, and the A–B repeat loop.

Both are stored server-side rather than in localStorage for the same reason as
watch history: a mark is about the video, not the browser that made it, so it
should still be there on another device (and after a cache clear). The loop
shares the file because it shares that key — one video id, marks on its
timeline — and because the page that draws them draws them together.

They differ in one way, and the routes below say so. A bookmark is a POINT, so
the marks simply coexist. A loop is a MODE — several passages can be saved but
only one repeats at a time — so its rows carry `active`, and setting it on one
clears it on the rest.

Deliberately thin: the client owns the "press `b` again to remove it" behaviour,
because it already holds the list and can answer instantly. This just stores
rows and hands them back in playback order.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth
from app.database import async_session
from app.models import Bookmark, User, VideoLoop

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


class LoopPayload(BaseModel):
    """Seconds, or null for an end that isn't pinned.

    `active` is optional on a PATCH so that moving an end and switching passages
    are separate edits — pinning `[` on the running loop shouldn't have to
    restate that it's the running one."""
    a: float | None = None
    b: float | None = None
    active: bool | None = None


def _serialize_loop(row: VideoLoop) -> dict:
    return {
        "id": row.id,
        "a": row.a_seconds,
        "b": row.b_seconds,
        "active": bool(row.active),
    }


async def _loops(db: AsyncSession, user: User, video_id: str) -> list[VideoLoop]:
    """This video's passages, in the order they were marked.

    Insertion order, not position order — unlike bookmarks, which are stepped
    through with the video. A loop list is a list of jobs, and the order you
    took them on is the order you recognise them in."""
    return list((await db.execute(
        select(VideoLoop)
        .where(VideoLoop.user_id == user.id, VideoLoop.video_id == video_id)
        .order_by(VideoLoop.id)
    )).scalars().all())


async def _owned_loop(db: AsyncSession, user: User, loop_id: int) -> VideoLoop:
    row = await db.get(VideoLoop, loop_id)
    # Somebody else's loop is "no such loop", for the same reason a bookmark is.
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="No such loop")
    return row


async def _deactivate_siblings(db: AsyncSession, row: VideoLoop) -> None:
    """Only one passage of a video repeats at a time — that's what makes a loop
    a mode rather than a mark. Enforced here, at the one place that sets it."""
    await db.execute(
        update(VideoLoop)
        .where(
            VideoLoop.user_id == row.user_id,
            VideoLoop.video_id == row.video_id,
            VideoLoop.id != row.id,
        )
        .values(active=False)
    )


def _serialize(b: Bookmark) -> dict:
    return {
        "id": b.id,
        "video_id": b.video_id,
        "position_seconds": b.position_seconds or 0.0,
        "note": b.note or "",
        "created_at": b.created_at.isoformat() if b.created_at else None,
    }


@router.get("/{video_id}/loops")
async def list_loops(
    video_id: str,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """This video's saved passages. An empty list is the ordinary answer — the
    page asks on every video it opens — so there's no 404 here."""
    return [_serialize_loop(row) for row in await _loops(db, user, video_id)]


@router.post("/{video_id}/loops")
async def add_loop(
    video_id: str,
    p: LoopPayload,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Mark a new passage. It becomes the running one, because you only mark a
    passage when it's the one you're about to work on."""
    row = VideoLoop(
        user_id=user.id,
        video_id=video_id,
        a_seconds=p.a,
        b_seconds=p.b,
        active=True if p.active is None else p.active,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(row)
    await db.flush()
    if row.active:
        await _deactivate_siblings(db, row)
    await db.commit()
    return _serialize_loop(row)


@router.patch("/{video_id}/loops/id/{loop_id}")
async def edit_loop(
    video_id: str,
    loop_id: int,
    p: LoopPayload,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Move an end, or switch to this passage — the two edits the page makes.

    PATCH rather than PUT because they're independent: `[` moves an end on the
    running loop without restating that it's running, and picking a passage out
    of the menu switches to it without touching where its ends are. An end is
    moved only when the field is sent, so null still means "unpin that end"."""
    row = await _owned_loop(db, user, loop_id)
    fields = p.model_dump(exclude_unset=True)
    if "a" in fields:
        row.a_seconds = p.a
    if "b" in fields:
        row.b_seconds = p.b
    if "active" in fields and p.active is not None:
        row.active = p.active
        if p.active:
            await _deactivate_siblings(db, row)
    row.updated_at = datetime.utcnow()
    await db.commit()
    return _serialize_loop(row)


@router.delete("/{video_id}/loops/id/{loop_id}")
async def remove_loop(
    video_id: str,
    loop_id: int,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Drop a passage for good — the menu's ×.

    Distinct from stopping the repeat, which is `active = false` and keeps the
    passage in the list. Nothing is promoted in its place: which passage runs
    next is the page's call, and usually the answer is none."""
    row = await _owned_loop(db, user, loop_id)
    await db.execute(delete(VideoLoop).where(VideoLoop.id == row.id))
    await db.commit()
    return {"status": "ok"}


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
