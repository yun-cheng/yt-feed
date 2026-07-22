"""
Feed endpoints — ranked videos grouped by category.
"""

import asyncio
import json
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

# In-memory caption cache: "video_id::lang" -> (timestamp, {cues, lang}-or-None).
# Keyed by language too, so switching tracks doesn't collide. Captions never
# change; the TTL only bounds memory growth over a long-running process.
_cc_cache: dict[str, tuple[float, Optional[dict]]] = {}
_CC_TTL = 86400  # 24 hours

# The available caption TRACKS (subtitles + automatic_captions) per video, cached
# so the language list and every per-language fetch share ONE yt-dlp extraction.
_ct_cache: dict[str, tuple[float, Optional[tuple]]] = {}

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
_cc_inflight: dict[str, "asyncio.Future[Optional[dict]]"] = {}
_ct_inflight: dict[str, "asyncio.Future[Optional[tuple]]"] = {}
_desc_inflight: dict[str, "asyncio.Future[Optional[str]]"] = {}

# Caption languages we expose in the watch-page switcher, in menu order. A track
# whose code starts with one of these prefixes (e.g. "zh-Hant" → "zh") counts.
# YouTube's auto-translate makes most of these available on any captioned video.
CAPTION_LANG_OPTIONS = [
    ("en", "English"),
    ("zh", "中文"),
    ("ja", "日本語"),
    ("ko", "한국어"),
]

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


def _extract_caption_tracks(video_id: str) -> tuple[dict, dict, str | None]:
    """Blocking yt-dlp extraction of a video's caption tracks. Runs in the pool.

    Returns (subtitles, automatic_captions, source_language) — the two maps of
    {lang_code: [track, …]} yt-dlp reports plus the video's own spoken language,
    which is what both the language list and every per-language fetch derive from.
    """
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
    return info.get("subtitles") or {}, info.get("automatic_captions") or {}, info.get("language")


async def _fetch_caption_tracks(video_id: str) -> tuple | None:
    try:
        return await asyncio.get_event_loop().run_in_executor(
            _preview_pool, _extract_caption_tracks, video_id
        )
    except Exception:
        return None


def _caption_tracks(video_id: str) -> "Awaitable[Optional[tuple]]":
    """The cached (subs, auto, source_lang) tuple for a video — one extraction
    shared by the language list and every per-language caption fetch."""
    return _cached_fetch(
        video_id, _ct_cache, _ct_inflight,
        lambda: _fetch_caption_tracks(video_id), _CC_TTL,
    )


def _json3(tracks: list | None) -> dict | None:
    return next((t for t in (tracks or []) if t.get("ext") == "json3"), None)


def _pick_track(subs: dict, auto: dict, source_lang: str | None, lang: str):
    """Choose the json3 caption track to render, returning (track, resolved_code).

    With an explicit `lang` the user's choice wins: a human subtitle in that
    language, else the original ASR track, else an auto-TRANSLATED track (YouTube
    can translate any captioned video). With no `lang` we serve the video's native
    captions — uploaded subs first, then the original ASR track — matching the
    long-standing default.
    """
    if lang:
        base = lang.split("-")[0].lower()

        def in_lang(source: dict, *, original_only: bool = False) -> tuple[dict, str] | None:
            for key, tracks in source.items():
                if key.split("-")[0].lower() != base:
                    continue
                t = _json3(tracks)
                if t and (not original_only or "tlang=" not in t.get("url", "")):
                    return t, key
            return None

        hit = (in_lang(subs) or in_lang(auto, original_only=True) or in_lang(auto))
        if hit:
            return hit
        # Requested language unavailable → fall through to the native default.

    prefs = [p for p in (source_lang, "en") if p]

    def pick_lang(source: dict) -> tuple[list, str] | None:
        for p in prefs:
            if p in source:
                return source[p], p
        for p in prefs:  # regional variant, e.g. zh-TW for zh, en-US for en
            b = p.split("-")[0]
            for key, tracks in source.items():
                if key.split("-")[0] == b:
                    return tracks, key
        return None

    # 1. Human-uploaded subtitles are cleanest — prefer native, else whatever the
    #    creator uploaded (usually the native one).
    if subs:
        picked = pick_lang(subs)
        key = picked[1] if picked else next(iter(subs))
        tracks = picked[0] if picked else subs[key]
        t = _json3(tracks)
        if t:
            return t, key
    # 2. Otherwise auto-captions: preferred language, else the ORIGINAL ASR track
    #    (no `tlang=`) rather than a machine translation.
    if auto:
        picked = pick_lang(auto)
        if picked:
            t = _json3(picked[0])
            if t:
                return t, picked[1]
        for key, tracks in auto.items():
            t = _json3(tracks)
            if t and "tlang=" not in t.get("url", ""):
                return t, key
        key = next(iter(auto))
        t = _json3(auto[key])
        if t:
            return t, key
    return None


def _parse_json3(url: str) -> list[dict] | None:
    """Download a json3 caption track and parse it into timed cues."""
    import json
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
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
        start_ms = ev.get("tStartMs", 0)
        # Per-word timing: auto-caption segments carry a tOffsetMs from the event
        # start, which lets the client reveal words one at a time (the rolling
        # effect the YouTube player shows). Manual subs have no offset, so every
        # word lands at the cue start = whole line at once.
        words = [
            {
                "t": round((start_ms + (s.get("tOffsetMs") or 0)) / 1000, 3),
                "text": s.get("utf8", "").replace("\n", " "),
            }
            for s in segs
            if s.get("utf8", "").strip()
        ]
        cues.append({
            "start": round(start_ms / 1000, 3),
            "dur": round(ev.get("dDurationMs", 0) / 1000, 3),
            "text": text,
            "words": words,
        })
    return cues or None


async def _fetch_captions(video_id: str, lang: str = "") -> dict | None:
    """Timed caption cues for a video, as {cues, lang}, or None if none.

    `lang` picks the track language (one of CAPTION_LANG_OPTIONS' codes); empty
    means the video's native captions. `lang` in the result is the resolved base
    code (e.g. "zh"), so the client can highlight the active choice.
    """
    tracks = await _caption_tracks(video_id)
    if not tracks:
        return None
    subs, auto, source_lang = tracks
    picked = _pick_track(subs, auto, source_lang, lang)
    if not picked or not picked[0].get("url"):
        return None
    try:
        cues = await asyncio.get_event_loop().run_in_executor(
            _preview_pool, _parse_json3, picked[0]["url"]
        )
    except Exception:
        return None
    if not cues:
        return None
    resolved = picked[1].split("-")[0].lower() if picked[1] else None
    return {"cues": cues, "lang": resolved}


async def _available_caption_langs(video_id: str) -> list[dict]:
    """The subset of CAPTION_LANG_OPTIONS this video genuinely PROVIDES, in menu
    order — for the watch-page language switcher.

    Only real tracks count: human-uploaded subtitles and the original ASR track.
    YouTube can auto-*translate* into ~100 languages (those carry `tlang=` in the
    URL), but those aren't offered by the video — including them would show all
    four on nearly every video — so they're excluded.
    """
    tracks = await _caption_tracks(video_id)
    if not tracks:
        return []
    subs, auto, _ = tracks
    prefixes = {k.split("-")[0].lower() for k in subs}
    for key, tk in auto.items():
        t = _json3(tk)
        if t and "tlang=" not in t.get("url", ""):  # original ASR, not a translation
            prefixes.add(key.split("-")[0].lower())
    return [{"code": code, "label": label} for code, label in CAPTION_LANG_OPTIONS if code in prefixes]


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
    try:
        title_labels = json.loads(v.title_labels) if v.title_labels else None
    except (ValueError, TypeError):
        title_labels = None
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
        "title_labels": title_labels,
    }


@router.get("/caption-langs/{video_id}")
async def get_caption_langs(video_id: str):
    """Return the caption languages this video offers, e.g. [{code, label}, …]."""
    return {"langs": await _available_caption_langs(video_id)}


@router.get("/captions/{video_id}")
async def get_captions(video_id: str, lang: str = ""):
    """Return timed caption cues for a video as {cues, lang}, or {cues: []}.

    `lang` selects the track language (empty = the video's native captions).
    """
    data = await _cached_fetch(
        f"{video_id}::{lang}", _cc_cache, _cc_inflight,
        lambda: _fetch_captions(video_id, lang), _CC_TTL,
    )
    return data or {"cues": []}


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