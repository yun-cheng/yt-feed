"""Local folders — browse a directory of video files as its own feed.

Not everything worth watching came from YouTube: a folder of lesson recordings
on a synced drive has no channel, no id and no metadata endpoint. Point this at
a directory and it lists what's inside as cards, plays them from disk in the
same custom control bar the downloads use, and remembers where you stopped.

Each folder stays its own page (see LocalFolder): folders are added and removed
whole, and mixing two unrelated directories into one list would lose the only
grouping the user actually gave us.

Nothing here ever writes to the user's directory — it's read, probed and served.
Removing a folder from the app deletes our rows and our generated thumbnails,
never the videos.
"""

import asyncio
import hashlib
import mimetypes
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session
from app.models import LocalFolder, LocalVideo

router = APIRouter(prefix="/local")

# What counts as a video. The browser can't play all of these (.avi, and .mkv
# depends on its codecs), but listing a file we can see and refusing to mention
# it is worse than listing it and failing loudly on play.
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".mpg", ".mpeg", ".ogv"}

# ffprobe/ffmpeg are blocking subprocesses. Bounded so scanning a folder of a
# hundred clips doesn't fork a hundred ffprobes at once.
PROBE_CONCURRENCY = 4
_media_pool = ThreadPoolExecutor(max_workers=PROBE_CONCURRENCY, thread_name_prefix="localmedia")

# Below this, a position isn't "where I stopped" — it's a click. Same threshold
# the YouTube-side history uses.
MIN_PROGRESS_SEC = 5.0
# Within this of the end counts as finished, so the last few seconds of credits
# don't leave a video forever "in progress".
END_TAIL_SEC = 15.0


async def get_db():
    async with async_session() as session:
        yield session


class FolderRequest(BaseModel):
    path: str
    name: str = ""


class ProgressRequest(BaseModel):
    position_seconds: float
    duration_seconds: int = 0


def _video_id(folder_id: int, rel_path: str) -> str:
    return hashlib.sha1(f"{folder_id}\0{rel_path}".encode()).hexdigest()[:16]


def _thumb_path(video_id: str) -> str:
    return os.path.join(settings.local_thumbs_dir, f"{video_id}.jpg")


def _abs_path(folder: LocalFolder, rel_path: str) -> str:
    """The file's absolute path, refusing anything that escapes the folder.

    rel_path comes from our own scan, so this is belt-and-braces — but it's the
    one place a stored value turns into a filesystem read, and a stale row plus
    a symlinked tree shouldn't be able to serve /etc/passwd.
    """
    root = os.path.realpath(folder.path)
    full = os.path.realpath(os.path.join(root, rel_path))
    if full != root and not full.startswith(root + os.sep):
        raise HTTPException(status_code=400, detail="Path escapes its folder")
    return full


def _walk(root: str) -> list[tuple[str, os.stat_result]]:
    """Every video file under `root`, as (path relative to root, stat)."""
    found: list[tuple[str, os.stat_result]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Skip dotfolders (and, on a synced drive, their sync metadata).
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith(".") or Path(name).suffix.lower() not in VIDEO_EXTS:
                continue
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except OSError:
                continue  # vanished mid-walk, or a cloud placeholder we can't read
            found.append((os.path.relpath(full, root), st))
    return found


def _probe_duration(path: str) -> int:
    """Duration in whole seconds via ffprobe; 0 if it can't be read."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=60,
        )
        return int(float(out.stdout.strip() or 0))
    except Exception:  # noqa: BLE001 — no ffprobe, bad file, timeout: all mean "unknown"
        return 0


def _make_thumb(src: str, dst: str, duration: int) -> bool:
    """Extract one poster frame. A tenth of the way in, so it isn't a black
    fade-in, capped so a long video doesn't seek halfway through the file."""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    ts = min(max(duration * 0.1, 1.0), 60.0) if duration else 1.0
    try:
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{ts:.2f}", "-i", src,
             "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", "-y", dst],
            capture_output=True, timeout=120,
        )
    except Exception:  # noqa: BLE001 — a missing ffmpeg just means no poster frame
        return False
    return os.path.exists(dst) and os.path.getsize(dst) > 0


def _serialize(v: LocalVideo) -> dict:
    return {
        "id": v.id,
        "folder_id": v.folder_id,
        "title": v.title,
        "rel_path": v.rel_path,
        # Only set for a file in a subdirectory — the folder page groups by it.
        "sub_dir": os.path.dirname(v.rel_path),
        "duration_seconds": v.duration_seconds or 0,
        # False = the duration isn't known yet, not "zero seconds long".
        "probed": bool(v.probed),
        "filesize": v.filesize or 0,
        "modified_at": datetime.utcfromtimestamp(v.mtime).isoformat() if v.mtime else "",
        "position_seconds": v.position_seconds or 0.0,
        "watched": bool(v.watched),
        "file_url": f"/api/local/videos/{v.id}/file",
        "thumbnail_url": f"/api/local/videos/{v.id}/thumb",
    }


def _serialize_folder(f: LocalFolder, video_count: int) -> dict:
    return {
        "id": f.id,
        "path": f.path,
        "name": f.name or os.path.basename(f.path.rstrip(os.sep)),
        "video_count": video_count,
        # A synced/removable drive can go away; the page says so rather than
        # showing an empty folder as if you'd added an empty one.
        "available": os.path.isdir(f.path),
        "created_at": f.created_at.isoformat() if f.created_at else None,
    }


def _drop_thumb(video_id: str) -> None:
    path = _thumb_path(video_id)
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass


# Folder ids with a probe pass running. Reading a duration means reading the
# file, which on a cloud-synced drive streams it down — minutes for a folder of
# them — so probing happens in the background and the listing never waits on it.
_probing: set[int] = set()


async def _sync_folder(db: AsyncSession, folder: LocalFolder) -> list[LocalVideo]:
    """Reconcile our rows for one folder against what's on disk.

    Only the directory walk happens here (fast, stat-only). New or changed files
    land with `probed = False` and are measured afterwards by _probe_folder;
    rows whose file is gone are dropped, with the thumbnail we generated for it.
    """
    rows = (await db.execute(
        select(LocalVideo).where(LocalVideo.folder_id == folder.id)
    )).scalars().all()
    by_rel = {r.rel_path: r for r in rows}

    if not os.path.isdir(folder.path):
        # Unavailable (unmounted drive, folder moved). Keep the rows — the drive
        # coming back shouldn't cost a full re-probe — and report what we have.
        return sorted(rows, key=lambda r: r.rel_path)

    loop = asyncio.get_event_loop()
    found = await loop.run_in_executor(_media_pool, _walk, folder.path)

    live: list[LocalVideo] = []
    for rel, st in found:
        row = by_rel.get(rel)
        if row is None:
            row = LocalVideo(
                id=_video_id(folder.id, rel),
                folder_id=folder.id,
                rel_path=rel,
                title=Path(rel).stem,
                created_at=datetime.utcnow(),
            )
            db.add(row)
        if row.filesize != st.st_size or row.mtime != st.st_mtime:
            # New, or replaced since we last looked: the cached duration and the
            # poster frame both describe a file that no longer exists.
            row.filesize = st.st_size
            row.mtime = st.st_mtime
            row.probed = False
            _drop_thumb(row.id)
        live.append(row)

    on_disk = {rel for rel, _ in found}
    for rel, row in by_rel.items():
        if rel not in on_disk:
            _drop_thumb(row.id)
            await db.delete(row)

    await db.commit()

    if any(not row.probed for row in live):
        _start_probe(folder.id)
    return sorted(live, key=lambda r: r.rel_path)


def _start_probe(folder_id: int) -> None:
    """Schedule a probe pass, unless one is already running.

    Registers the folder synchronously: the task doesn't actually start until
    this request yields, so a flag set inside it would leave the very response
    that scheduled the pass reporting `scanning: false` — and the UI would never
    poll for the durations it's about to produce.
    """
    if folder_id in _probing:
        return
    _probing.add(folder_id)
    asyncio.create_task(_probe_folder(folder_id))


async def _probe_folder(folder_id: int) -> None:
    """Fill in durations for the folder's unprobed files, a few at a time.

    Committing each small batch is the point: the folder page polls while this
    runs, so durations appear as they're measured instead of all at the end.
    Never raises — it's a background task, and a folder that goes away mid-pass
    (unplugged drive, deleted from the app) must not take the loop down with it.
    Always entered through _start_probe, which owns the "already running" guard.
    """
    loop = asyncio.get_event_loop()
    try:
        while True:
            async with async_session() as db:
                folder = await db.get(LocalFolder, folder_id)
                if folder is None or not os.path.isdir(folder.path):
                    return
                batch = (await db.execute(
                    select(LocalVideo)
                    .where(LocalVideo.folder_id == folder_id, LocalVideo.probed == False)  # noqa: E712
                    .order_by(LocalVideo.rel_path)
                    .limit(PROBE_CONCURRENCY)
                )).scalars().all()
                if not batch:
                    return
                durations = await asyncio.gather(*(
                    loop.run_in_executor(_media_pool, _probe_duration,
                                         os.path.join(folder.path, row.rel_path))
                    for row in batch
                ))
                for row, duration in zip(batch, durations):
                    row.duration_seconds = duration
                    row.probed = True
                await db.commit()
    except Exception as e:  # noqa: BLE001 — background pass; log and stop
        print(f"[local] probe of folder {folder_id} stopped: {e}")
    finally:
        _probing.discard(folder_id)


@router.get("/folders")
async def list_folders(db: AsyncSession = Depends(get_db)):
    """Every folder added, newest first, with the video count we last scanned."""
    folders = (await db.execute(
        select(LocalFolder).order_by(LocalFolder.created_at.desc())
    )).scalars().all()
    counts: dict[int, int] = {}
    for fid, in await db.execute(select(LocalVideo.folder_id)):
        counts[fid] = counts.get(fid, 0) + 1
    return [_serialize_folder(f, counts.get(f.id, 0)) for f in folders]


@router.post("/folders")
async def add_folder(req: FolderRequest, db: AsyncSession = Depends(get_db)):
    """Add a directory and scan it. Idempotent: re-adding one rescans it."""
    raw = req.path.strip()
    if not raw:
        raise HTTPException(status_code=400, detail="No path given")
    path = os.path.realpath(os.path.expanduser(raw))
    if not os.path.isdir(path):
        raise HTTPException(status_code=400, detail=f"Not a directory: {path}")
    if not os.access(path, os.R_OK):
        raise HTTPException(status_code=400, detail=f"Not readable: {path}")

    folder = (await db.execute(
        select(LocalFolder).where(LocalFolder.path == path)
    )).scalar_one_or_none()
    if folder is None:
        folder = LocalFolder(path=path, name=req.name.strip(), created_at=datetime.utcnow())
        db.add(folder)
        await db.commit()

    videos = await _sync_folder(db, folder)
    return {
        "folder": _serialize_folder(folder, len(videos)),
        "videos": [_serialize(v) for v in videos],
        "scanning": folder.id in _probing,
    }


@router.get("/folders/{folder_id}")
async def get_folder(folder_id: int, db: AsyncSession = Depends(get_db)):
    folder = await db.get(LocalFolder, folder_id)
    if folder is None:
        raise HTTPException(status_code=404, detail="No such folder")
    count = len((await db.execute(
        select(LocalVideo.id).where(LocalVideo.folder_id == folder_id)
    )).scalars().all())
    return _serialize_folder(folder, count)


@router.get("/folders/{folder_id}/videos")
async def list_folder_videos(folder_id: int, rescan: bool = True, db: AsyncSession = Depends(get_db)):
    """The folder's videos. Rescans by default — the directory is the source of
    truth and can change behind our back; `?rescan=false` reads the cache only."""
    folder = await db.get(LocalFolder, folder_id)
    if folder is None:
        raise HTTPException(status_code=404, detail="No such folder")
    if rescan:
        videos = await _sync_folder(db, folder)
    else:
        videos = sorted((await db.execute(
            select(LocalVideo).where(LocalVideo.folder_id == folder_id)
        )).scalars().all(), key=lambda r: r.rel_path)
    return {
        "folder": _serialize_folder(folder, len(videos)),
        "videos": [_serialize(v) for v in videos],
        # The UI polls while this is true — durations land as they're measured.
        "scanning": folder_id in _probing,
    }


@router.delete("/folders/{folder_id}")
async def remove_folder(folder_id: int, db: AsyncSession = Depends(get_db)):
    """Forget a folder. Deletes our rows and thumbnails — never the video files."""
    folder = await db.get(LocalFolder, folder_id)
    if folder is None:
        return {"ok": True}
    rows = (await db.execute(
        select(LocalVideo).where(LocalVideo.folder_id == folder_id)
    )).scalars().all()
    for row in rows:
        thumb = _thumb_path(row.id)
        if os.path.exists(thumb):
            try:
                os.remove(thumb)
            except OSError:
                pass
        await db.delete(row)
    await db.delete(folder)
    await db.commit()
    return {"ok": True}


@router.get("/videos/{video_id}")
async def get_video(video_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(LocalVideo, video_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No such video")
    return _serialize(row)


@router.get("/videos/{video_id}/file")
async def get_video_file(video_id: str, db: AsyncSession = Depends(get_db)):
    """Serve the file itself. FileResponse handles range requests, so seeking
    and the scrub preview work without downloading the whole thing."""
    row = await db.get(LocalVideo, video_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No such video")
    folder = await db.get(LocalFolder, row.folder_id)
    if folder is None:
        raise HTTPException(status_code=404, detail="No such folder")
    path = _abs_path(folder, row.rel_path)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File is gone")
    media_type = mimetypes.guess_type(path)[0] or "video/mp4"
    return FileResponse(path, media_type=media_type)


@router.get("/videos/{video_id}/thumb")
async def get_video_thumb(video_id: str, db: AsyncSession = Depends(get_db)):
    """A poster frame, extracted on first request and cached on disk."""
    row = await db.get(LocalVideo, video_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No such video")
    dst = _thumb_path(video_id)
    if not os.path.exists(dst):
        folder = await db.get(LocalFolder, row.folder_id)
        if folder is None:
            raise HTTPException(status_code=404, detail="No such folder")
        src = _abs_path(folder, row.rel_path)
        if not os.path.exists(src):
            raise HTTPException(status_code=404, detail="File is gone")
        loop = asyncio.get_event_loop()
        ok = await loop.run_in_executor(_media_pool, _make_thumb, src, dst, row.duration_seconds or 0)
        if not ok:
            raise HTTPException(status_code=404, detail="No thumbnail")
    return FileResponse(dst, media_type="image/jpeg")


@router.post("/videos/{video_id}/progress")
async def report_progress(video_id: str, req: ProgressRequest, db: AsyncSession = Depends(get_db)):
    """Record where playback got to, so the next visit resumes there."""
    row = await db.get(LocalVideo, video_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No such video")
    if req.position_seconds < MIN_PROGRESS_SEC:
        return _serialize(row)  # a click, not a watch
    row.position_seconds = req.position_seconds
    duration = req.duration_seconds or row.duration_seconds or 0
    if duration and not row.duration_seconds:
        row.duration_seconds = duration
    # Sticky, like the YouTube-side history: a rewatch that stops halfway doesn't
    # un-finish the video.
    if duration and duration - req.position_seconds <= END_TAIL_SEC:
        row.watched = True
    await db.commit()
    return _serialize(row)


@router.delete("/videos/{video_id}/progress")
async def clear_progress(video_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(LocalVideo, video_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No such video")
    row.position_seconds = 0.0
    row.watched = False
    await db.commit()
    return _serialize(row)
