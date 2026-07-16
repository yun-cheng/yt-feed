"""
Feed endpoints — ranked videos grouped by category.
"""

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Awaitable, Callable, Optional, TypeVar
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import Channel, Video
from app.ranking import TimeWindow, rank_videos, score_video
from app.categorizer import get_categories, get_channel_groups

router = APIRouter(prefix="/feed")

# Dedicated, BOUNDED pool for the blocking yt-dlp preview fetches (storyboard,
# captions). Separate from the default executor so a burst of hovers can't starve
# other blocking work (e.g. downloads), and bounded so a hover storm naturally
# throttles instead of opening dozens of concurrent yt-dlp connections to YouTube.
_preview_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="preview")

# In-memory storyboard cache: video_id -> (timestamp, data-or-None)
_sb_cache: dict[str, tuple[float, Optional[dict]]] = {}
_SB_TTL = 3600  # 1 hour

# In-memory caption cache: video_id -> (timestamp, cues-or-None). Captions never
# change; the TTL only bounds memory growth over a long-running process.
_cc_cache: dict[str, tuple[float, Optional[list[dict]]]] = {}
_CC_TTL = 86400  # 24 hours

# In-memory description cache: video_id -> (timestamp, text-or-None). Descriptions
# are only ever fetched on demand for the watch page and deliberately NOT stored in
# the DB — they're multi-KB blobs nothing else in the app reads.
_desc_cache: dict[str, tuple[float, Optional[str]]] = {}
_DESC_TTL = 3600  # 1 hour

# Empty/failed results are cached too (so a caption-less video isn't re-fetched on
# every hover) but with a short TTL, so a transient network failure retries soon.
_NEG_TTL = 300  # 5 min

# In-flight fetches, so concurrent requests for the same video (multiple cards, or
# a quick re-hover) share ONE yt-dlp call instead of each launching their own.
_sb_inflight: dict[str, "asyncio.Future[Optional[dict]]"] = {}
_cc_inflight: dict[str, "asyncio.Future[Optional[list[dict]]]"] = {}
_desc_inflight: dict[str, "asyncio.Future[Optional[str]]"] = {}

_T = TypeVar("_T")


async def _cached_fetch(
    key: str,
    cache: dict[str, tuple[float, Optional[_T]]],
    inflight: dict[str, "asyncio.Future[Optional[_T]]"],
    fetch: Callable[[], Awaitable[Optional[_T]]],
    pos_ttl: float,
) -> Optional[_T]:
    """Serve `key` from cache, coalescing concurrent misses into one `fetch()`.

    Positive results live for `pos_ttl`; empty/None results for `_NEG_TTL`.
    """
    now = time.time()
    hit = cache.get(key)
    if hit:
        ts, val = hit
        if now - ts < (pos_ttl if val else _NEG_TTL):
            return val

    task = inflight.get(key)
    if task is None:
        async def _go() -> Optional[_T]:
            try:
                val = await fetch()
                cache[key] = (time.time(), val)
                return val
            finally:
                inflight.pop(key, None)
        task = asyncio.ensure_future(_go())
        inflight[key] = task
    return await task


def _storyboard_from_info(info: dict) -> dict | None:
    """Pick the best storyboard format out of a yt-dlp info dict."""
    # Find highest-quality storyboard format (sb0 is highest, then sb1, sb2, sb3)
    sb_fmts = [f for f in info.get("formats", []) if f.get("format_id", "").startswith("sb")]
    if not sb_fmts:
        return None
    # Pick the best (lowest sb number = highest quality)
    sb_fmts.sort(key=lambda f: f.get("format_id", "sb9"))
    best = sb_fmts[0]
    fragments = best.get("fragments", [])
    if not fragments:
        return None
    return {
        "rows": best.get("rows", 10),
        "cols": best.get("columns", 10),
        "frame_width": best.get("width", 160),
        "frame_height": best.get("height", 90),
        "fragment_urls": [fr["url"] for fr in fragments],
        "fragment_duration": fragments[0].get("duration", 0) if fragments else 0,
    }


def _extract_info(video_id: str) -> dict:
    """Blocking full yt-dlp extraction for one video. Runs in `_preview_pool`."""
    import yt_dlp
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": False,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)


async def _fetch_storyboard(video_id: str) -> dict | None:
    """Run yt-dlp in a thread to get storyboard fragment URLs.

    The same extraction also carries the description, so stash it on the way past:
    hovering a card is what triggers this, and hovering is almost always how you
    reach the watch page — so the description is usually already warm by then.
    """
    def _run():
        info = _extract_info(video_id)
        return _storyboard_from_info(info), info.get("description") or None

    try:
        sb, desc = await asyncio.get_event_loop().run_in_executor(_preview_pool, _run)
    except Exception:
        return None
    _desc_cache[video_id] = (time.time(), desc)
    return sb


async def _fetch_description(video_id: str) -> str | None:
    """Fetch a video's description via yt-dlp. Only used when no hover warmed it."""
    try:
        info = await asyncio.get_event_loop().run_in_executor(_preview_pool, _extract_info, video_id)
    except Exception:
        return None
    return info.get("description") or None


async def _fetch_captions(video_id: str, lang: str = "en") -> list[dict] | None:
    """
    Fetch a video's timed caption track via yt-dlp and parse it into cues.

    Serves the video's NATIVE captions (e.g. Chinese for a Chinese video), not a
    forced language: prefers human-uploaded subtitles, then the original ASR track.
    `lang` is only a soft preference used to break ties. Returns a list of
    {start, dur, text} (seconds), or None if none available. Rendering the transcript
    ourselves avoids the embedded player's tiny/unreliable caption rendering.
    """
    def _run():
        import json
        import urllib.request

        import yt_dlp

        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "writesubtitles": True,
            "writeautomaticsub": True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(
                f"https://www.youtube.com/watch?v={video_id}", download=False
            )

        subs = info.get("subtitles") or {}
        auto = info.get("automatic_captions") or {}
        # The video's own language (e.g. "zh", "en") is the native caption we want;
        # fall back to the requested `lang` only when yt-dlp doesn't report it.
        prefs = [p for p in (info.get("language"), lang, "en") if p]

        def json3(tracks: list | None) -> dict | None:
            return next((t for t in (tracks or []) if t.get("ext") == "json3"), None)

        def pick_lang(source: dict) -> list | None:
            for p in prefs:
                if p in source:
                    return source[p]
            for p in prefs:  # regional variant, e.g. zh-TW for zh, en-US for en
                base = p.split("-")[0]
                for key, tracks in source.items():
                    if key.split("-")[0] == base:
                        return tracks
            return None

        j3 = None
        # 1. Human-uploaded subtitles are cleanest — prefer the native language,
        #    else just take whatever the creator uploaded (usually the native one).
        if subs:
            j3 = json3(pick_lang(subs) or next(iter(subs.values())))
        # 2. Otherwise auto-captions. Prefer a preferred-language track, but if none
        #    matches, use the ORIGINAL ASR track (the spoken language) rather than a
        #    machine translation — the translated tracks carry `tlang=` in their URL.
        if j3 is None and auto:
            j3 = json3(pick_lang(auto))
            if j3 is None:
                for tracks in auto.values():
                    t = json3(tracks)
                    if t and "tlang=" not in t.get("url", ""):
                        j3 = t
                        break
                j3 = j3 or json3(next(iter(auto.values())))
        if j3 is None:
            return None

        req = urllib.request.Request(j3["url"], headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())

        cues: list[dict] = []
        for ev in data.get("events", []):
            segs = ev.get("segs")
            if not segs:
                continue
            text = "".join(s.get("utf8", "") for s in segs).replace("\n", " ").strip()
            if not text:
                continue
            cues.append({
                "start": round(ev.get("tStartMs", 0) / 1000, 3),
                "dur": round(ev.get("dDurationMs", 0) / 1000, 3),
                "text": text,
            })
        return cues or None

    try:
        return await asyncio.get_event_loop().run_in_executor(_preview_pool, _run)
    except Exception:
        return None


async def get_db():
    async with async_session() as session:
        yield session


@router.get("")
async def get_feed(
    window: TimeWindow = Query(default=TimeWindow.ONE_WEEK, alias="window"),
    sort: str = Query(default="likes", description="score | views | newest | oldest"),
    group: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    """
    Return ranked videos, grouped by category.

    - window: time filter (1w, 2w, 1m, 3m, 6m, 1y)
    - sort: sort mode (score, views, newest, oldest)
    - group: filter to a specific category (omit for all)
    """
    # 1. Load categories + channel-group mapping
    categories = get_categories()
    channel_groups = get_channel_groups()

    # 2. Build {group_name: [channel_ids]}
    groups: dict[str, list[str]] = {}
    for cid, entry in channel_groups.items():
        # entry format: "auto:科技" or "科技"
        group_name = entry.split(":", 1)[-1] if ":" in entry else entry
        groups.setdefault(group_name, []).append(cid)

    # 3. Query videos (fetch more to support lazy loading)
    stmt = select(Video).order_by(Video.published_at.desc()).limit(2000)
    result = await db.execute(stmt)
    all_videos = result.scalars().all()

    # 4. Build channel_id → channel_title + group_name map
    chan_stmt = select(Channel.youtube_id, Channel.title, Channel.group_name, Channel.thumbnail_url)
    chan_result = await db.execute(chan_stmt)
    channel_map = {r.youtube_id: {"title": r.title, "group": r.group_name, "thumbnail": r.thumbnail_url} for r in chan_result}
    chan_titles = {cid: info["title"] for cid, info in channel_map.items()}
    chan_thumbs = {cid: info["thumbnail"] for cid, info in channel_map.items()}

    # 5. Group and rank
    response_groups = []
    uncategorized_videos = []

    for cat in categories:
        name = cat["name"]
        if group and name != group:
            continue

        cids = groups.get(name, [])
        group_videos = [v for v in all_videos if v.channel_id in cids]
        if not group_videos:
            continue

        ranked = rank_videos(group_videos, window, chan_titles, sort=sort, channel_thumbnails=chan_thumbs)
        response_groups.append({
            "name": name,
            "icon": cat.get("icon", ""),
            "sort_order": cat.get("sort_order", 0),
            "videos": ranked,
        })

    # 6. Uncategorized channels (not in any category group)
    if not group:
        uncategorized = [v for v in all_videos if v.channel_id not in channel_groups]
        if uncategorized:
            ranked_uncat = rank_videos(uncategorized, window, chan_titles, sort=sort, channel_thumbnails=chan_thumbs)
            if ranked_uncat:
                response_groups.append({
                    "name": "其他",
                    "icon": "📌",
                    "sort_order": 99,
                    "videos": ranked_uncat,
                })

    # 6. Sort groups by sort_order
    response_groups.sort(key=lambda g: g["sort_order"])

    return {
        "categories": categories,
        "groups": response_groups,
        "window": window.value,
    }


@router.get("/storyboard/{video_id}")
async def get_storyboard(video_id: str):
    """Return storyboard (preview thumbnail) info for a video."""
    data = await _cached_fetch(
        video_id, _sb_cache, _sb_inflight,
        lambda: _fetch_storyboard(video_id), _SB_TTL,
    )
    return data or {}


@router.get("/video/{video_id}")
async def get_video(video_id: str, db: AsyncSession = Depends(get_db)):
    """Single video's metadata for the in-app watch page (deep links / refresh).

    Returns {} if the id isn't in the DB — the watch page still plays the embed
    from the id alone, just with minimal chrome.
    """
    v = await db.get(Video, video_id)
    if not v:
        return {}
    chan = await db.get(Channel, v.channel_id)
    return {
        "youtube_id": v.youtube_id,
        "title": v.title,
        "channel_id": v.channel_id,
        "channel_name": chan.title if chan else "",
        "channel_thumbnail": chan.thumbnail_url if chan else "",
        "thumbnail_url": v.thumbnail_url,
        "published_at": v.published_at.isoformat(),
        "view_count": v.view_count,
        "like_count": v.like_count,
        "duration_seconds": v.duration_seconds,
        "is_short": bool(v.is_short),
        "score": round(score_video(v.view_count, v.published_at), 2),
    }


@router.get("/captions/{video_id}")
async def get_captions(video_id: str, lang: str = "en"):
    """Return timed caption cues [{start, dur, text}] for a video, or {cues: []}."""
    cues = await _cached_fetch(
        video_id, _cc_cache, _cc_inflight,
        lambda: _fetch_captions(video_id, lang), _CC_TTL,
    )
    return {"cues": cues or []}


@router.get("/description/{video_id}")
async def get_description(video_id: str):
    """Return a video's description for the watch page, or {description: ""}.

    Fetched on demand rather than stored: descriptions are multi-KB and nothing
    else reads them, so they live only in a TTL cache.
    """
    text = await _cached_fetch(
        video_id, _desc_cache, _desc_inflight,
        lambda: _fetch_description(video_id), _DESC_TTL,
    )
    return {"description": text or ""}


@router.get("/statistics")
async def get_feed_statistics(db: AsyncSession = Depends(get_db)):
    """Return total video/channel counts."""
    chan_count = await db.execute(select(Channel).count())
    vid_count = await db.execute(select(Video).count())
    return {
        "channels": chan_count.scalar_one(),
        "videos": vid_count.scalar_one(),
    }