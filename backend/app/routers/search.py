"""Search endpoint — proxies queries to Meilisearch, returns two result sections."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth, search_index, users
from app.models import User

router = APIRouter(prefix="/search")


@router.get("")
async def search(
    q: str = Query(default="", description="search query (channel name or video title)"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=30, ge=1, le=100),
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(auth.get_db),
):
    """Return {'channels', 'videos', 'videos_total'} ranked, typo-tolerant.

    Narrowed to the channels you follow. The index is shared catalog, so without
    this a search would reach straight past the feed into everybody's library.
    """
    return await search_index.search(
        q, limit=limit, offset=offset,
        channel_ids=await users.held_channel_ids(db, user),
    )


@router.post("/reindex")
async def reindex():
    """Force a full re-push of channels + videos into Meilisearch."""
    await search_index.ensure_indexes()
    return await search_index.reindex_all()
