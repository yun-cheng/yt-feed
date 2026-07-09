"""Search endpoint — proxies queries to Meilisearch, returns two result sections."""

from fastapi import APIRouter, Query

from app import search_index

router = APIRouter(prefix="/search")


@router.get("")
async def search(
    q: str = Query(default="", description="search query (channel name or video title)"),
    limit: int = Query(default=20, ge=1, le=50),
):
    """Return {'channels': [...], 'videos': [...]} ranked, typo-tolerant."""
    return await search_index.search(q, limit=limit)


@router.post("/reindex")
async def reindex():
    """Force a full re-push of channels + videos into Meilisearch."""
    await search_index.ensure_indexes()
    return await search_index.reindex_all()
