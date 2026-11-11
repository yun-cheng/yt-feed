"""
Meilisearch integration — smart, typo-tolerant search over channels + video titles.

Meilisearch is a small companion service (default :7700) that does the heavy
lifting: typo tolerance, Chinese word segmentation, prefix + ranked search. We
just push documents into it and proxy queries.

Design notes:
- Two indexes: "videos" and "channels", so the UI can show two result sections.
- A full reindex re-pushes everything, but the corpus is no longer small (the
  archive fill brought it to ~180k videos, 67 MB a push), so it runs only when
  the index is out of step with the database or someone asks for one. The
  scheduled scan pushes just the videos it touched (`index_changed_since`).
- Nothing is pushed onto a queue Meilisearch isn't working through: each push
  is kept as a file until it's indexed, so a stalled Meilisearch fed a push a
  scan once filled the disk with 1,000 copies of the corpus (33 GB).
- Every call is best-effort: if Meilisearch is down, we swallow the error so the
  rest of the app keeps working (search just returns nothing).
"""

from __future__ import annotations

from datetime import datetime

import httpx
from sqlalchemy import func, select

from app import runtime_config
from app.config import settings
from app.database import async_session
from app.models import Channel, Video

VIDEOS_INDEX = "videos"
CHANNELS_INDEX = "channels"

# Short timeouts: search must feel instant, and a hung Meili shouldn't stall us.
_SEARCH_TIMEOUT = 3.0
_ADMIN_TIMEOUT = 30.0

# How many pushes may wait in Meilisearch's queue before we stop adding more.
# A healthy queue is empty within seconds of each push; one this long isn't
# moving, and every push it holds is a file on disk.
MAX_WAITING = 3
# Only pushes are counted: they're what's kept as files. ensure_indexes queues
# a few settings tasks of its own just before the startup reindex.
_PUSHES = "documentAdditionOrUpdate"
# How many ids to read from an index at a time, to find what it holds that the
# database no longer does.
_ID_PAGE = 50_000


def _headers() -> dict[str, str]:
    # Read per call rather than captured: the key is a setting now (Settings →
    # Connections), so pointing this at a different Meilisearch has to take
    # effect without a restart.
    key = runtime_config.meili_master_key()
    return {"Authorization": f"Bearer {key}"} if key else {}


async def _client(timeout: float) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=settings.meili_url, headers=_headers(), timeout=timeout
    )


async def is_available() -> bool:
    try:
        async with await _client(_SEARCH_TIMEOUT) as c:
            r = await c.get("/health")
            return r.status_code == 200
    except Exception:
        return False


async def ensure_indexes() -> None:
    """Create the two indexes and configure their searchable fields (idempotent)."""
    try:
        async with await _client(_ADMIN_TIMEOUT) as c:
            for uid in (VIDEOS_INDEX, CHANNELS_INDEX):
                # createIndex is a no-op (409) if it already exists — fine.
                await c.post("/indexes", json={"uid": uid, "primaryKey": "youtube_id"})

            # Videos: match on title first, then the channel that posted it.
            await c.patch(
                f"/indexes/{VIDEOS_INDEX}/settings",
                json={
                    "searchableAttributes": ["title", "channel_name"],
                    "sortableAttributes": ["view_count", "published_ts"],
                    # So a search can be narrowed to the channels the person
                    # asking actually follows. The index itself stays shared —
                    # it's catalog, and a copy per person would be the same
                    # documents N times.
                    "filterableAttributes": ["channel_id"],
                },
            )
            # Channels: match on the channel name.
            await c.patch(
                f"/indexes/{CHANNELS_INDEX}/settings",
                json={
                    "searchableAttributes": ["title"],
                    "filterableAttributes": ["youtube_id"],
                },
            )
    except Exception as e:  # never let search setup break startup
        print(f"[search] ensure_indexes skipped: {e}")


async def _waiting(c: httpx.AsyncClient) -> int:
    """How many pushes Meilisearch has yet to start."""
    r = await c.get("/tasks", params={"statuses": "enqueued", "types": _PUSHES, "limit": 1})
    r.raise_for_status()
    return int(r.json().get("total", 0))


async def _stalled(c: httpx.AsyncClient) -> bool:
    """Whether Meilisearch's queue is too long to add to, saying so if it is."""
    waiting = await _waiting(c)
    if waiting >= MAX_WAITING:
        print(f"[search] push skipped: {waiting} tasks already waiting in Meilisearch")
        return True
    return False


def _video_doc(v: Video, channel_name: str) -> dict:
    return {
        "youtube_id": v.youtube_id,
        "title": v.title or "",
        "channel_id": v.channel_id,
        "channel_name": channel_name,
        "thumbnail_url": v.thumbnail_url or "",
        "published_at": v.published_at.isoformat() if v.published_at else "",
        "published_ts": int(v.published_at.timestamp()) if v.published_at else 0,
        "view_count": v.view_count or 0,
        "like_count": v.like_count or 0,
        "duration_seconds": v.duration_seconds or 0,
    }


async def _held_ids(c: httpx.AsyncClient, index: str) -> set[str]:
    """Every document id `index` holds."""
    ids: set[str] = set()
    offset = 0
    while True:
        r = await c.get(f"/indexes/{index}/documents",
                        params={"fields": "youtube_id", "limit": _ID_PAGE, "offset": offset})
        r.raise_for_status()
        page = r.json().get("results", [])
        ids.update(d["youtube_id"] for d in page)
        if len(page) < _ID_PAGE:
            return ids
        offset += _ID_PAGE


async def reindex_all() -> dict[str, int]:
    """Push every channel + video into Meilisearch, and take out what the
    database no longer has. Best-effort; returns counts pushed."""
    try:
        async with await _client(_ADMIN_TIMEOUT) as c:
            if await _stalled(c):
                return {"channels": 0, "videos": 0}
        async with async_session() as session:
            chan_rows = (await session.execute(
                select(Channel.youtube_id, Channel.title, Channel.thumbnail_url)
            )).all()
            channel_name = {r.youtube_id: r.title for r in chan_rows}

            vid_rows = (await session.execute(select(Video))).scalars().all()

        channel_docs = [
            {
                "youtube_id": r.youtube_id,
                "title": r.title or "",
                "thumbnail_url": r.thumbnail_url or "",
            }
            for r in chan_rows
        ]
        video_docs = [_video_doc(v, channel_name.get(v.channel_id, "")) for v in vid_rows]

        async with await _client(_ADMIN_TIMEOUT) as c:
            if channel_docs:
                await c.post(f"/indexes/{CHANNELS_INDEX}/documents", json=channel_docs)
            if video_docs:
                await c.post(f"/indexes/{VIDEOS_INDEX}/documents", json=video_docs)
            # A push only adds and updates: what was deleted without
            # remove_documents (by hand, or before it existed) would stay a
            # search hit, and the index never match the database's count.
            for index, docs in ((CHANNELS_INDEX, channel_docs), (VIDEOS_INDEX, video_docs)):
                gone = sorted(await _held_ids(c, index) - {d["youtube_id"] for d in docs})
                if gone:
                    await c.post(f"/indexes/{index}/documents/delete-batch", json=gone)

        return {"channels": len(channel_docs), "videos": len(video_docs)}
    except Exception as e:
        print(f"[search] reindex skipped (Meilisearch unavailable?): {e}")
        return {"channels": 0, "videos": 0}


async def index_videos(video_ids: list[str]) -> int:
    """Push just these videos. Best-effort; returns how many were sent.

    `reindex_all` costs the whole corpus however few documents actually changed,
    which is the wrong price for an archive fill that adds a page at a time.
    """
    if not video_ids:
        return 0
    try:
        async with async_session() as session:
            vid_rows = (await session.execute(
                select(Video).where(Video.youtube_id.in_(video_ids))
            )).scalars().all()
            if not vid_rows:
                return 0
            names = dict((await session.execute(
                select(Channel.youtube_id, Channel.title).where(
                    Channel.youtube_id.in_({v.channel_id for v in vid_rows})
                )
            )).all())

        docs = [_video_doc(v, names.get(v.channel_id, "")) for v in vid_rows]
        async with await _client(_ADMIN_TIMEOUT) as c:
            if await _stalled(c):
                return 0
            await c.post(f"/indexes/{VIDEOS_INDEX}/documents", json=docs)
        return len(docs)
    except Exception as e:
        print(f"[search] index_videos skipped (Meilisearch unavailable?): {e}")
        return 0


async def index_changed_since(since: datetime) -> dict[str, int]:
    """Push every channel, and the videos added or refreshed since `since`.

    What the scheduled scan changes: the videos it found and those whose stats
    it refreshed, each stamped with `last_updated`. The channels are a few
    hundred rows, so they all go, which keeps a renamed one current.
    """
    try:
        async with async_session() as session:
            ids = list((await session.execute(
                select(Video.youtube_id).where(Video.last_updated >= since)
            )).scalars())
            chan_rows = (await session.execute(
                select(Channel.youtube_id, Channel.title, Channel.thumbnail_url)
            )).all()
        channel_docs = [
            {"youtube_id": r.youtube_id, "title": r.title or "", "thumbnail_url": r.thumbnail_url or ""}
            for r in chan_rows
        ]
        async with await _client(_ADMIN_TIMEOUT) as c:
            if await _stalled(c):
                return {"channels": 0, "videos": 0}
            if channel_docs:
                await c.post(f"/indexes/{CHANNELS_INDEX}/documents", json=channel_docs)
        return {"channels": len(channel_docs), "videos": await index_videos(ids)}
    except Exception as e:
        print(f"[search] index_changed_since skipped (Meilisearch unavailable?): {e}")
        return {"channels": 0, "videos": 0}


async def reindex_if_out_of_step() -> dict[str, int] | None:
    """A full reindex, only when the index doesn't hold what the database
    does: on startup, which `--reload` makes every save. Returns the counts
    pushed, or None when it was already in step."""
    try:
        async with async_session() as session:
            want = {
                VIDEOS_INDEX: (await session.execute(select(func.count()).select_from(Video))).scalar_one(),
                CHANNELS_INDEX: (await session.execute(select(func.count()).select_from(Channel))).scalar_one(),
            }
        async with await _client(_ADMIN_TIMEOUT) as c:
            have = {}
            for uid in want:
                r = await c.get(f"/indexes/{uid}/stats")
                have[uid] = r.json().get("numberOfDocuments") if r.status_code == 200 else None
        if have == want:
            return None
    except Exception as e:
        print(f"[search] index check skipped (Meilisearch unavailable?): {e}")
        return None
    return await reindex_all()


async def remove_documents(
    channel_ids: list[str] | None = None, video_ids: list[str] | None = None
) -> None:
    """Delete specific channel + video docs from Meilisearch.

    reindex_all() only ever upserts, so removed rows would otherwise linger as
    stale search hits. Call this when pruning unsubscribed channels. Best-effort.
    """
    channel_ids = list(channel_ids or [])
    video_ids = list(video_ids or [])
    if not channel_ids and not video_ids:
        return
    try:
        async with await _client(_ADMIN_TIMEOUT) as c:
            if video_ids:
                await c.post(
                    f"/indexes/{VIDEOS_INDEX}/documents/delete-batch", json=video_ids
                )
            if channel_ids:
                await c.post(
                    f"/indexes/{CHANNELS_INDEX}/documents/delete-batch", json=channel_ids
                )
    except Exception as e:  # never let a prune fail on search bookkeeping
        print(f"[search] remove_documents skipped: {e}")


async def _search_raw(
    index: str, q: str, limit: int, offset: int = 0, filter: str | None = None
) -> dict:
    body: dict = {"q": q, "limit": limit, "offset": offset}
    if filter:
        body["filter"] = filter
    async with await _client(_SEARCH_TIMEOUT) as c:
        r = await c.post(f"/indexes/{index}/search", json=body)
        r.raise_for_status()
        return r.json()


def _in_filter(field: str, values) -> str:
    """A Meili `field IN [...]` clause. Ids are opaque YouTube strings, but they
    are quoted anyway — an unquoted value with a space or a reserved word would
    be read as syntax rather than data."""
    quoted = ", ".join('"{}"'.format(v.replace('"', '')) for v in sorted(values))
    return f"{field} IN [{quoted}]"


async def search(
    q: str, limit: int = 20, offset: int = 0, channel_ids: set[str] | None = None
) -> dict:
    """Return {'channels', 'videos', 'videos_total'} for a query. Empty on failure.

    Channels are just the top few (no pagination); the video results paginate
    via offset/limit, with videos_total from Meilisearch's estimate.

    `channel_ids` narrows both sections to the channels the asker follows. The
    index is shared — it's catalog — so this filter is the only thing keeping one
    person's search out of another's library. `None` means "don't narrow", which
    is why callers pass a set rather than letting it default; an EMPTY set is
    distinct and returns nothing, because someone who follows no channels should
    see no results rather than everybody's.
    """
    q = (q or "").strip()
    if not q:
        return {"channels": [], "videos": [], "videos_total": 0}
    if channel_ids is not None and not channel_ids:
        return {"channels": [], "videos": [], "videos_total": 0}
    try:
        vfilter = cfilter = None
        if channel_ids is not None:
            vfilter = _in_filter("channel_id", channel_ids)
            cfilter = _in_filter("youtube_id", channel_ids)
        channels = (await _search_raw(
            CHANNELS_INDEX, q, 8, 0, cfilter
        )).get("hits", [])
        vres = await _search_raw(VIDEOS_INDEX, q, limit, offset, vfilter)
        videos = vres.get("hits", [])
        # score isn't stored; VideoCard tolerates it missing, default to 0.
        for v in videos:
            v.setdefault("score", 0)
        return {
            "channels": channels,
            "videos": videos,
            "videos_total": vres.get("estimatedTotalHits", len(videos)),
        }
    except Exception as e:
        print(f"[search] query failed: {e}")
        return {"channels": [], "videos": [], "videos_total": 0}


async def matching_channel_ids(
    q: str, channel_ids: set[str], cap: int = 500
) -> list[str] | None:
    """Which of the channels someone follows match `q` — ids, in Meili's order.

    The Channels page holds its whole list and does its own tag matching and
    ranking, so it asks Meilisearch for the one thing only it can answer: which
    names match once typos and Chinese segmentation are allowed for.

    `None` means the index could not answer at all, which is different from "no
    channel matches": the caller falls back to plain substring matching rather
    than showing an empty page because a companion service is down.
    """
    q = (q or "").strip()
    if not q or not channel_ids:
        return []
    try:
        res = await _search_raw(
            CHANNELS_INDEX, q, cap, 0, _in_filter("youtube_id", channel_ids)
        )
        return [h["youtube_id"] for h in res.get("hits", []) if h.get("youtube_id")]
    except Exception as e:
        print(f"[search] channel-name query failed: {e}")
        return None


async def matching_video_ids(q: str, channel_id: str, cap: int = 500) -> list[str]:
    """Which of one channel's videos match `q` — ids only, best-effort.

    The channel page does its own windowing, ranking and paging over rows in the
    DB, so searching inside a channel asks Meilisearch for the one thing only it
    can answer (which titles match, typos and Chinese segmentation included) and
    leaves everything else where it already works. The list comes back in
    RELEVANCE order, which the caller keeps only when the page's bar asks for it
    — every other sort is the page's own.

    `cap` bounds the id list a SQL `IN` is handed. A query matching more than
    that inside a single channel is one nobody is reading to the end anyway.
    """
    q = (q or "").strip()
    if not q:
        return []
    try:
        res = await _search_raw(
            VIDEOS_INDEX, q, cap, 0, _in_filter("channel_id", [channel_id])
        )
        return [h["youtube_id"] for h in res.get("hits", []) if h.get("youtube_id")]
    except Exception as e:
        print(f"[search] channel query failed: {e}")
        return []
