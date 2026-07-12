"""
Hidden channels — channels the user has hidden from the home feed.

Server-side (SQLite) so it syncs across devices and the feed query can exclude
them before they ever reach the client. Replaces the old browser-localStorage
version.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import HiddenChannel

router = APIRouter(prefix="/hidden-channels")


async def get_db():
    async with async_session() as session:
        yield session


class ImportRequest(BaseModel):
    channel_ids: list[str]


@router.get("")
async def list_hidden(db: AsyncSession = Depends(get_db)):
    """All hidden channel IDs."""
    result = await db.execute(select(HiddenChannel.channel_id))
    return {"channel_ids": [r[0] for r in result]}


@router.post("/import")
async def import_hidden(body: ImportRequest, db: AsyncSession = Depends(get_db)):
    """Bulk-add hidden channels (one-time migration from localStorage). Idempotent."""
    existing = {r[0] for r in await db.execute(select(HiddenChannel.channel_id))}
    for cid in body.channel_ids:
        if cid and cid not in existing:
            db.add(HiddenChannel(channel_id=cid))
            existing.add(cid)
    await db.commit()
    return {"channel_ids": sorted(existing)}


@router.post("/{channel_id}")
async def hide_channel(channel_id: str, db: AsyncSession = Depends(get_db)):
    """Hide a channel from the home feed. Idempotent."""
    exists = await db.get(HiddenChannel, channel_id)
    if not exists:
        db.add(HiddenChannel(channel_id=channel_id))
        await db.commit()
    return {"channel_id": channel_id, "hidden": True}


@router.delete("/{channel_id}")
async def unhide_channel(channel_id: str, db: AsyncSession = Depends(get_db)):
    """Un-hide a channel."""
    await db.execute(delete(HiddenChannel).where(HiddenChannel.channel_id == channel_id))
    await db.commit()
    return {"channel_id": channel_id, "hidden": False}
