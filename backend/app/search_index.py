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
                },
            )
            # Channels: match on the channel name.
            await c.patch(
                f"/indexes/{CHANNELS_INDEX}/settings",
                json={"searchableAttributes": ["title"]},
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


async def _search_raw(index: str, q: str, limit: int, offset: int = 0) -> dict:
    async with await _client(_SEARCH_TIMEOUT) as c:
        r = await c.post(
            f"/indexes/{index}/search",
            json={"q": q, "limit": limit, "offset": offset},
        )
        r.raise_for_status()
        return r.json()


async def search(q: str, limit: int = 20, offset: int = 0) -> dict:
    """Return {'channels', 'videos', 'videos_total'} for a query. Empty on failure.

    Channels are just the top few (no pagination); the video results paginate
    via offset/limit, with videos_total from Meilisearch's estimate.
    """
    q = (q or "").strip()
    if not q:
        return {"channels": [], "videos": [], "videos_total": 0}
    try:
        channels = (await _search_raw(CHANNELS_INDEX, q, 8, 0)).get("hits", [])
        vres = await _search_raw(VIDEOS_INDEX, q, limit, offset)
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
