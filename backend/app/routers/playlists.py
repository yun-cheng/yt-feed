"""Playlists — user-created video collections (server-side, YouTube-style)."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import Playlist, PlaylistItem

router = APIRouter(prefix="/playlists")


async def get_db():
    async with async_session() as session:
        yield session


class PlaylistCreate(BaseModel):
    name: str


class PlaylistRename(BaseModel):
    name: str


class VideoPayload(BaseModel):
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


def _video_dict(it: PlaylistItem) -> dict:
    return {
        "youtube_id": it.youtube_id,
        "title": it.title,
        "channel_id": it.channel_id,
        "channel_name": it.channel_name,
        "thumbnail_url": it.thumbnail_url,
        "duration_seconds": it.duration_seconds,
        "published_at": it.published_at,
        "view_count": it.view_count,
        "like_count": it.like_count,
        "score": it.score,
    }


@router.get("")
async def list_playlists(db: AsyncSession = Depends(get_db)):
    """All playlists with item count + a cover thumbnail (newest item)."""
    playlists = (await db.execute(
        select(Playlist).order_by(Playlist.created_at.desc())
    )).scalars().all()

    # counts per playlist
    counts = dict((await db.execute(
        select(PlaylistItem.playlist_id, func.count()).group_by(PlaylistItem.playlist_id)
    )).all())

    out = []
    for p in playlists:
        cover = (await db.execute(
            select(PlaylistItem.thumbnail_url)
            .where(PlaylistItem.playlist_id == p.id)
            .order_by(PlaylistItem.added_at.desc())
            .limit(1)
        )).scalar_one_or_none()
        out.append({
            "id": p.id,
            "name": p.name,
            "item_count": counts.get(p.id, 0),
            "thumbnail_url": cover or "",
            "created_at": p.created_at.isoformat() if p.created_at else None,
        })
    return out


@router.post("")
async def create_playlist(body: PlaylistCreate, db: AsyncSession = Depends(get_db)):
    name = body.name.strip() or "New playlist"
    p = Playlist(name=name, created_at=datetime.utcnow())
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return {"id": p.id, "name": p.name, "item_count": 0, "thumbnail_url": ""}


@router.patch("/{playlist_id}")
async def rename_playlist(playlist_id: int, body: PlaylistRename, db: AsyncSession = Depends(get_db)):
    p = await db.get(Playlist, playlist_id)
    if not p:
        raise HTTPException(404, "Playlist not found")
    p.name = body.name.strip() or p.name
    await db.commit()
    return {"id": p.id, "name": p.name}


@router.delete("/{playlist_id}")
async def delete_playlist(playlist_id: int, db: AsyncSession = Depends(get_db)):
    await db.execute(delete(PlaylistItem).where(PlaylistItem.playlist_id == playlist_id))
    await db.execute(delete(Playlist).where(Playlist.id == playlist_id))
    await db.commit()
    return {"status": "ok"}


@router.get("/containing/{youtube_id}")
async def playlists_containing(youtube_id: str, db: AsyncSession = Depends(get_db)):
    """IDs of playlists that already contain this video (for the save-to menu)."""
    rows = (await db.execute(
        select(PlaylistItem.playlist_id).where(PlaylistItem.youtube_id == youtube_id).distinct()
    )).all()
    return [r[0] for r in rows]


@router.get("/{playlist_id}")
async def get_playlist(playlist_id: int, db: AsyncSession = Depends(get_db)):
    p = await db.get(Playlist, playlist_id)
    if not p:
        raise HTTPException(404, "Playlist not found")
    items = (await db.execute(
        select(PlaylistItem)
        .where(PlaylistItem.playlist_id == playlist_id)
        .order_by(PlaylistItem.added_at.desc())
    )).scalars().all()
    return {"id": p.id, "name": p.name, "videos": [_video_dict(it) for it in items]}


@router.post("/{playlist_id}/items")
async def add_item(playlist_id: int, video: VideoPayload, db: AsyncSession = Depends(get_db)):
    p = await db.get(Playlist, playlist_id)
    if not p:
        raise HTTPException(404, "Playlist not found")
    exists = (await db.execute(
        select(PlaylistItem).where(
            PlaylistItem.playlist_id == playlist_id,
            PlaylistItem.youtube_id == video.youtube_id,
        )
    )).scalar_one_or_none()
    if exists is None:
        db.add(PlaylistItem(playlist_id=playlist_id, added_at=datetime.utcnow(), **video.model_dump()))
        await db.commit()
    return {"status": "ok"}


@router.delete("/{playlist_id}/items/{youtube_id}")
async def remove_item(playlist_id: int, youtube_id: str, db: AsyncSession = Depends(get_db)):
    await db.execute(delete(PlaylistItem).where(
        PlaylistItem.playlist_id == playlist_id,
        PlaylistItem.youtube_id == youtube_id,
    ))
    await db.commit()
    return {"status": "ok"}
