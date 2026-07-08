"""
Offline downloads — download videos to disk (server-side) and serve them back
for in-app playback, like YouTube's "Downloads" library.
"""

import asyncio
import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session
from app.models import Download

router = APIRouter(prefix="/downloads")


async def get_db():
    async with async_session() as session:
        yield session


class DownloadRequest(BaseModel):
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


def _file_path(video_id: str) -> str:
    return os.path.join(settings.downloads_dir, f"{video_id}.mp4")


def _serialize(d: Download) -> dict:
    return {
        "youtube_id": d.youtube_id,
        "title": d.title,
        "channel_id": d.channel_id,
        "channel_name": d.channel_name,
        "thumbnail_url": d.thumbnail_url,
        "duration_seconds": d.duration_seconds,
        "published_at": d.published_at or "",
        "view_count": d.view_count or 0,
        "like_count": d.like_count or 0,
        "score": d.score or 0.0,
        "status": d.status,
        "error": d.error or "",
        "filesize": d.filesize or 0,
        "created_at": d.created_at.isoformat() if d.created_at else None,
    }


def _download_file(video_id: str) -> int:
    """Blocking yt-dlp download to disk. Returns file size in bytes."""
    import yt_dlp

    os.makedirs(settings.downloads_dir, exist_ok=True)
    opts = {
        # Prefer mp4/m4a (h264+aac) so the browser <video> can play it; ffmpeg
        # merges the separate streams into a single .mp4 (higher quality than the
        # progressive-only formats a stdout stream would be limited to).
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "outtmpl": os.path.join(settings.downloads_dir, "%(id)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "overwrites": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
    path = _file_path(video_id)
    return os.path.getsize(path) if os.path.exists(path) else 0


async def _run_download(video_id: str):
    """Run the download off the event loop, then record the outcome."""
    loop = asyncio.get_event_loop()
    try:
        size = await loop.run_in_executor(None, _download_file, video_id)
        status, err = ("ready", "") if size > 0 else ("error", "no output file")
    except Exception as e:  # noqa: BLE001 — surface any yt-dlp/ffmpeg failure to the UI
        size, status, err = 0, "error", str(e)[:500]
    async with async_session() as session:
        rec = await session.get(Download, video_id)
        if rec:
            rec.status = status
            rec.filesize = size
            rec.error = err
            await session.commit()


@router.get("")
async def list_downloads(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Download).order_by(Download.created_at.desc()))
    return [_serialize(d) for d in result.scalars().all()]


@router.post("")
async def create_download(req: DownloadRequest, db: AsyncSession = Depends(get_db)):
    existing = await db.get(Download, req.youtube_id)
    if existing and existing.status in ("downloading", "ready"):
        return _serialize(existing)  # already downloading or done — idempotent

    if existing:  # retry a previously failed download
        existing.status = "downloading"
        existing.error = ""
        rec = existing
    else:
        rec = Download(
            youtube_id=req.youtube_id,
            title=req.title,
            channel_id=req.channel_id,
            channel_name=req.channel_name,
            thumbnail_url=req.thumbnail_url,
            duration_seconds=req.duration_seconds,
            published_at=req.published_at,
            view_count=req.view_count,
            like_count=req.like_count,
            score=req.score,
            status="downloading",
        )
        db.add(rec)
    await db.commit()

    asyncio.create_task(_run_download(req.youtube_id))
    return _serialize(rec)


@router.get("/{video_id}/file")
async def get_download_file(video_id: str):
    """Serve the downloaded file (FileResponse supports range requests for seeking)."""
    path = _file_path(video_id)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Not downloaded")
    return FileResponse(path, media_type="video/mp4")


@router.delete("/{video_id}")
async def delete_download(video_id: str, db: AsyncSession = Depends(get_db)):
    rec = await db.get(Download, video_id)
    if rec:
        await db.delete(rec)
        await db.commit()
    path = _file_path(video_id)
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass
    return {"ok": True}
