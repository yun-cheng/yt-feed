"""The bell — things that finished while you were on another page.

Background work has a reporting problem: it ends somewhere nobody is looking.
The app already had one surface for saying something, `Toaster`, and it is the
wrong one — a toast is for the request you just made, it vanishes in fifteen
seconds, and it only exists in the tab that made the call. A summary started
before lunch has to still be there after it, in whichever tab you open.

So: rows, per user, with a read flag. Deliberately generic (`kind`, `title`,
`body`, optional `video_id`) because downloads, imports and a resync all end the
same way and should end up here too.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth
from app.database import async_session
from app.models import Notification, User

router = APIRouter(prefix="/notifications")

# What the bell holds. Old enough notifications are noise, not history — the
# thing they point at is still in the app, and this list is a "since you were
# away", not a log.
LIMIT = 50


async def get_db():
    async with async_session() as session:
        yield session


def _serialize(n: Notification) -> dict:
    return {
        "id": n.id,
        "kind": n.kind,
        "title": n.title,
        "body": n.body,
        "video_id": n.video_id or "",
        "thumbnail_url": n.thumbnail_url or "",
        "read": bool(n.read),
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }


@router.get("")
async def list_notifications(
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Newest first, plus the unread count the badge shows.

    The count is computed over ALL of them, not just the page returned: a badge
    that said 50 when there were 90 would be a lie in the one number people read.
    """
    rows = (await db.execute(
        select(Notification)
        .where(Notification.user_id == user.id)
        .order_by(Notification.id.desc())
        .limit(LIMIT)
    )).scalars().all()
    unread = (await db.execute(
        select(Notification).where(
            Notification.user_id == user.id, Notification.read.is_(False),
        )
    )).scalars().all()
    return {"notifications": [_serialize(n) for n in rows], "unread": len(unread)}


@router.post("/read")
async def mark_all_read(
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """What opening the bell does. Reading the list IS reading them."""
    await db.execute(update(Notification)
                     .where(Notification.user_id == user.id, Notification.read.is_(False))
                     .values(read=True))
    await db.commit()
    return {"ok": True}


@router.post("/{notification_id}/read")
async def mark_read(
    notification_id: int,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    n = await db.get(Notification, notification_id)
    if not n or n.user_id != user.id:
        raise HTTPException(404, "No such notification")
    n.read = True
    n.created_at = n.created_at or datetime.utcnow()
    await db.commit()
    return {"ok": True}


@router.delete("/{notification_id}")
async def dismiss(
    notification_id: int,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    n = await db.get(Notification, notification_id)
    if not n or n.user_id != user.id:
        raise HTTPException(404, "No such notification")
    await db.delete(n)
    await db.commit()
    return {"ok": True}


@router.delete("")
async def clear(
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(delete(Notification).where(Notification.user_id == user.id))
    await db.commit()
    return {"ok": True}
