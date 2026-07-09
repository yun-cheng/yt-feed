"""Search endpoint — proxies queries to Meilisearch, returns two result sections."""

from fastapi import APIRouter, Query

from app import search_index

router = APIRouter(prefix="/search")


@router.get("")
async def search(
    q: str = Query(default="", description="search query (channel name or video title)"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=30, ge=1, le=100),
):
    """Return {'channels', 'videos', 'videos_total'} ranked, typo-tolerant."""
    return await search_index.search(q, limit=limit, offset=offset)


@router.post("/reindex")
async def reindex():
    """Force a full re-push of channels + videos into Meilisearch."""
    await search_index.ensure_indexes()
    return await search_index.reindex_all()
