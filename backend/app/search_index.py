"""
Meilisearch integration — smart, typo-tolerant search over channels + video titles.

Meilisearch is a small companion service (default :7700) that does the heavy
lifting: typo tolerance, Chinese word segmentation, prefix + ranked search. We
just push documents into it and proxy queries.

Design notes:
- Two indexes: "videos" and "channels", so the UI can show two result sections.
- The dataset is tiny (thousands of rows), so we simply re-push everything on a
  full reindex rather than maintaining per-row sync — simple and never stale.
- Every call is best-effort: if Meilisearch is down, we swallow the error so the
  rest of the app keeps working (search just returns nothing).
"""

from __future__ import annotations

import httpx
from sqlalchemy import select

from app.config import settings
from app.database import async_session
from app.models import Channel, Video

VIDEOS_INDEX = "videos"
CHANNELS_INDEX = "channels"

# Short timeouts: search must feel instant, and a hung Meili shouldn't stall us.
_SEARCH_TIMEOUT = 3.0
_ADMIN_TIMEOUT = 30.0


def _headers() -> dict[str, str]:
    if settings.meili_master_key:
        return {"Authorization": f"Bearer {settings.meili_master_key}"}
    return {}


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


async def reindex_all() -> dict[str, int]:
    """Push every channel + video into Meilisearch. Best-effort; returns counts."""
    try:
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
        video_docs = [
            {
                "youtube_id": v.youtube_id,
                "title": v.title or "",
                "channel_id": v.channel_id,
                "channel_name": channel_name.get(v.channel_id, ""),
                "thumbnail_url": v.thumbnail_url or "",
                "published_at": v.published_at.isoformat() if v.published_at else "",
                "published_ts": int(v.published_at.timestamp()) if v.published_at else 0,
                "view_count": v.view_count or 0,
                "like_count": v.like_count or 0,
                "duration_seconds": v.duration_seconds or 0,
            }
            for v in vid_rows
        ]

        async with await _client(_ADMIN_TIMEOUT) as c:
            if channel_docs:
                await c.post(f"/indexes/{CHANNELS_INDEX}/documents", json=channel_docs)
            if video_docs:
                await c.post(f"/indexes/{VIDEOS_INDEX}/documents", json=video_docs)

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

        docs = [
            {
                "youtube_id": v.youtube_id,
                "title": v.title or "",
                "channel_id": v.channel_id,
                "channel_name": names.get(v.channel_id, ""),
                "thumbnail_url": v.thumbnail_url or "",
                "published_at": v.published_at.isoformat() if v.published_at else "",
                "published_ts": int(v.published_at.timestamp()) if v.published_at else 0,
                "view_count": v.view_count or 0,
                "like_count": v.like_count or 0,
                "duration_seconds": v.duration_seconds or 0,
            }
            for v in vid_rows
        ]
        async with await _client(_ADMIN_TIMEOUT) as c:
            await c.post(f"/indexes/{VIDEOS_INDEX}/documents", json=docs)
        return len(docs)
    except Exception as e:
        print(f"[search] index_videos skipped (Meilisearch unavailable?): {e}")
        return 0


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
