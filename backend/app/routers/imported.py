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
from typing import Any, Sequence

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth, quota
from app.database import async_session
from app.models import Channel, ImportedVideo, User, UserImport
from app.ranking import score_video
from app.youtube_api import fetch_channel_avatars, take_quota_delta

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


def _to_record(video_id: str, info: dict, source: str = "import") -> ImportedVideo:
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
        source=source,
    )


def _channel_thumb(info: dict) -> str:
    """The uploader's avatar, if this extraction happened to carry one.

    A VIDEO extraction doesn't: its `thumbnails` are that video's frames, ids
    "0".."41", with no `avatar_uncropped` among them. Kept because a channel or
    playlist extraction does carry one, and because it costs nothing to look —
    but `fill_channel_avatars` is what actually finds the picture.
    """
    for t in info.get("thumbnails") or []:
        if t.get("id") == "avatar_uncropped":
            return t.get("url") or ""
    return ""


async def fill_channel_avatars(records: Sequence[Any], db: AsyncSession) -> None:
    """Give each record its uploader's avatar, in place.

    Takes anything carrying `channel_id` and `channel_thumbnail` — ImportedVideo
    here, WatchHistory in scripts/fix_channel_avatars.py — because every snapshot
    table holds the same two columns and has the same hole in it.

    Two sources, cheapest first: a channel you're subscribed to already has its
    picture in `channels`, and only what's left costs an API call — one unit per
    50 channels, so a whole paste is a single unit.

    Best-effort throughout. No credentials, no quota, a channel that's gone: the
    card falls back to its initial, which is what it did before this existed.
    """
    need = {r.channel_id for r in records if r.channel_id and not r.channel_thumbnail}
    if not need:
        return

    known = {
        r[0]: r[1] for r in await db.execute(
            select(Channel.youtube_id, Channel.thumbnail_url)
            .where(Channel.youtube_id.in_(need))
        )
    }
    avatars = {cid: url for cid, url in known.items() if url}

    missing = sorted(need - set(avatars))
    if missing:
        loop = asyncio.get_event_loop()
        try:
            fetched = await loop.run_in_executor(None, fetch_channel_avatars, missing)
            avatars.update(fetched)
        except Exception as e:  # QuotaExceeded, auth, network
            print(f"[imported] could not fetch channel avatars: {e}")
        finally:
            # Against the day but NOT the archive's share — this is incidental to
            # opening a video, and must not eat the fetching budget.
            await quota.record(take_quota_delta(), archive=False)

    for rec in records:
        if not rec.channel_thumbnail:
            rec.channel_thumbnail = avatars.get(rec.channel_id, "")


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
async def list_imported(
    user: User = Depends(auth.account), db: AsyncSession = Depends(get_db)
):
    """Videos YOU imported, most recently imported first.

    `user_imports` is the list; `imported_videos` is the metadata behind it. The
    snapshot table also holds rows for videos opened through the extension's
    button, which exist so the watch page and history have a title to show —
    listing those would turn a page of things you chose to keep into a log of
    everything you clicked. And it's shared, so listing it whole would show you
    what somebody else kept.
    """
    rows = (await db.execute(
        select(ImportedVideo)
        .join(UserImport, UserImport.youtube_id == ImportedVideo.youtube_id)
        .where(UserImport.user_id == user.id)
        .order_by(UserImport.created_at.desc())
    )).scalars().all()
    return [_serialize(v) for v in rows]


@router.post("")
async def import_videos(
    req: ImportRequest,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Import every YouTube link in the pasted text.

    Partial success is the normal case (one dead link among five), so nothing
    here raises: each input lands in exactly one of added / skipped / failed and
    the UI reports the tally.

    Two writes per link: the metadata snapshot, shared with anyone who pastes the
    same video (one yt-dlp fetch, not one each), and your membership of it.
    """
    ids, bad = parse_video_ids(req.urls)
    failed = [{"input": t, "error": "not a YouTube link"} for t in bad]

    existing: set[str] = set()
    mine: set[str] = set()
    if ids:
        existing = {
            r[0] for r in await db.execute(
                select(ImportedVideo.youtube_id)
                .where(ImportedVideo.youtube_id.in_(ids))
            )
        }
        mine = {
            r[0] for r in await db.execute(
                select(UserImport.youtube_id).where(
                    UserImport.user_id == user.id, UserImport.youtube_id.in_(ids)
                )
            )
        }
    skipped = [vid for vid in ids if vid in mine]
    # The snapshot is already here — cached when you opened it from YouTube, or
    # fetched for somebody else who pasted it first. Either way pasting the link
    # is you asking to KEEP it, so take the membership rather than reporting
    # "already imported" about something that isn't on your page.
    promoted = [vid for vid in ids if vid in existing and vid not in mine]
    todo = [vid for vid in ids if vid not in existing]

    added = []
    for vid in promoted:
        rec = await db.get(ImportedVideo, vid)
        rec.source = "import"
        db.add(UserImport(user_id=user.id, youtube_id=vid,
                          created_at=datetime.utcnow()))
        added.append(_serialize(rec))

    loop = asyncio.get_event_loop()
    infos = await asyncio.gather(
        *(loop.run_in_executor(_import_pool, _extract, vid) for vid in todo),
        return_exceptions=True,
    )

    fresh = []
    for vid, info in zip(todo, infos):
        if isinstance(info, BaseException) or not info:
            failed.append({"input": vid, "error": str(info)[:200] or "could not fetch"})
            continue
        fresh.append(_to_record(vid, info))

    # One lookup for the whole paste, before serialising — the payload goes
    # straight to the cards, so the avatar has to be on it already.
    await fill_channel_avatars(fresh, db)
    for rec in fresh:
        db.add(rec)
        db.add(UserImport(user_id=user.id, youtube_id=rec.youtube_id,
                          created_at=datetime.utcnow()))
        added.append(_serialize(rec))
    if added or promoted:
        await db.commit()

    return {"added": added, "skipped": skipped, "failed": failed}


@router.delete("/{video_id}")
async def remove_imported(
    video_id: str,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Take it off your Imported page.

    The snapshot stays. It's a cache — the watch page and history still read it
    for a title, somebody else may have imported the same video, and re-pasting
    the link costs no fetch. What goes is your claim on it.
    """
    from sqlalchemy import delete as sa_delete

    await db.execute(sa_delete(UserImport).where(
        UserImport.user_id == user.id, UserImport.youtube_id == video_id
    ))
    await db.commit()
    return {"status": "ok"}
