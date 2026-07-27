"""Imported videos — one-off videos added by pasting a YouTube link.

The home feed only ever shows videos from channels you're subscribed to, so a
video someone sends you has nowhere to live. Importing one snapshots its
metadata (title, channel, thumbnail, stats) via yt-dlp into `imported_videos`;
the Imported page then renders it with the very same cards as the feed, so it
downloads, saves to a playlist and goes to Watch Later like any other video.
"""

import asyncio
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import ImportedVideo
from app.ranking import score_video

router = APIRouter(prefix="/imported")

# Small dedicated pool: an import is a handful of pasted links at a time, and
# each one is a blocking yt-dlp extraction. Bounded so pasting thirty links
# doesn't open thirty simultaneous connections to YouTube.
_import_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="import")

# A bare id is exactly 11 URL-safe chars; the URL forms all carry it in the
# first path/query segment. `live` and `v` are the older/stream variants.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_URL_RES = [
    re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})"),
    re.compile(r"[?&]v=([A-Za-z0-9_-]{11})"),
    re.compile(r"/(?:shorts|embed|live|v)/([A-Za-z0-9_-]{11})"),
]


async def get_db():
    async with async_session() as session:
        yield session


class ImportRequest(BaseModel):
    # The raw paste. Whitespace-separated, so one link per line or several on a
    # line both work — the UI hands over the textarea's contents verbatim.
    urls: str


def parse_video_ids(raw: str) -> tuple[list[str], list[str]]:
    """Split a pasted blob into (video ids, tokens that weren't YouTube links).

    Duplicates within one paste collapse to the first occurrence, so a list with
    the same link twice imports it once.
    """
    ids: list[str] = []
    bad: list[str] = []
    seen: set[str] = set()
    for token in raw.split():
        vid = None
        for pat in _URL_RES:
            m = pat.search(token)
            if m:
                vid = m.group(1)
                break
        if vid is None and _ID_RE.match(token):
            vid = token
        if vid is None:
            bad.append(token)
        elif vid not in seen:
            seen.add(vid)
            ids.append(vid)
    return ids, bad


def _extract(video_id: str) -> dict:
    """Blocking yt-dlp metadata extraction for one video. Runs in `_import_pool`."""
    import yt_dlp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)


def _published_at(info: dict) -> datetime:
    """Publish time from yt-dlp, as naive UTC (matching how the DB stores it)."""
    ts = info.get("timestamp") or info.get("release_timestamp")
    if ts:
        return datetime.fromtimestamp(ts, tz=timezone.utc).replace(tzinfo=None)
    raw = info.get("upload_date")  # "YYYYMMDD"
    if raw:
        try:
            return datetime.strptime(raw, "%Y%m%d")
        except ValueError:
            pass
    return datetime.utcnow()


def _to_record(video_id: str, info: dict) -> ImportedVideo:
    published = _published_at(info)
    views = int(info.get("view_count") or 0)
    width, height = info.get("width") or 0, info.get("height") or 0
    duration = int(info.get("duration") or 0)
    return ImportedVideo(
        youtube_id=video_id,
        title=info.get("title") or "",
        channel_id=info.get("channel_id") or info.get("uploader_id") or "",
        channel_name=info.get("channel") or info.get("uploader") or "",
        channel_thumbnail=_channel_thumb(info),
        thumbnail_url=info.get("thumbnail") or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        duration_seconds=duration,
        published_at=published.isoformat(),
        view_count=views,
        like_count=int(info.get("like_count") or 0),
        # yt-dlp doesn't flag Shorts, so infer it the way the format does:
        # portrait and short. 180s is YouTube's current Shorts ceiling.
        is_short=bool(height > width and 0 < duration <= 180),
        score=round(score_video(views, published), 2),
        # Set here rather than left to the column default so the record we hand
        # straight back to the UI already carries it (the default only lands on flush).
        created_at=datetime.utcnow(),
    )


def _channel_thumb(info: dict) -> str:
    """The uploader's avatar, if this extraction happened to carry one."""
    for t in info.get("thumbnails") or []:
        if t.get("id") == "avatar_uncropped":
            return t.get("url") or ""
    return ""


def _serialize(v: ImportedVideo) -> dict:
    """Shaped like a feed VideoItem, so the same cards render it."""
    return {
        "youtube_id": v.youtube_id,
        "title": v.title,
        "channel_id": v.channel_id,
        "channel_name": v.channel_name,
        "channel_thumbnail": v.channel_thumbnail or "",
        "thumbnail_url": v.thumbnail_url,
        "duration_seconds": v.duration_seconds,
        "published_at": v.published_at or "",
        "view_count": v.view_count or 0,
        "like_count": v.like_count or 0,
        "is_short": bool(v.is_short),
        "score": v.score or 0.0,
        "created_at": v.created_at.isoformat() if v.created_at else None,
    }


@router.get("")
async def list_imported(db: AsyncSession = Depends(get_db)):
    """Imported videos, most recently imported first."""
    rows = (await db.execute(
        select(ImportedVideo).order_by(ImportedVideo.created_at.desc())
    )).scalars().all()
    return [_serialize(v) for v in rows]


@router.post("")
async def import_videos(req: ImportRequest, db: AsyncSession = Depends(get_db)):
    """Import every YouTube link in the pasted text.

    Partial success is the normal case (one dead link among five), so nothing
    here raises: each input lands in exactly one of added / skipped / failed and
    the UI reports the tally.
    """
    ids, bad = parse_video_ids(req.urls)
    failed = [{"input": t, "error": "not a YouTube link"} for t in bad]

    existing = set()
    if ids:
        existing = {
            r[0] for r in await db.execute(
                select(ImportedVideo.youtube_id).where(ImportedVideo.youtube_id.in_(ids))
            )
        }
    skipped = [vid for vid in ids if vid in existing]
    todo = [vid for vid in ids if vid not in existing]

    loop = asyncio.get_event_loop()
    infos = await asyncio.gather(
        *(loop.run_in_executor(_import_pool, _extract, vid) for vid in todo),
        return_exceptions=True,
    )

    added = []
    for vid, info in zip(todo, infos):
        if isinstance(info, BaseException) or not info:
            failed.append({"input": vid, "error": str(info)[:200] or "could not fetch"})
            continue
        rec = _to_record(vid, info)
        db.add(rec)
        added.append(_serialize(rec))
    if added:
        await db.commit()

    return {"added": added, "skipped": skipped, "failed": failed}


@router.delete("/{video_id}")
async def remove_imported(video_id: str, db: AsyncSession = Depends(get_db)):
    rec = await db.get(ImportedVideo, video_id)
    if rec:
        await db.delete(rec)
        await db.commit()
    return {"status": "ok"}
