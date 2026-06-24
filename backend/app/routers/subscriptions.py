from __future__ import annotations

import yaml
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import Channel
from app.config import settings

router = APIRouter(prefix="/subscriptions")


class ImportChannel(BaseModel):
    youtube_id: str
    title: str = ""
    description: str = ""
    thumbnail_url: str = ""
    subscriber_count: int = 0


async def get_db():
    async with async_session() as session:
        yield session


@router.get("")
async def list_subscriptions():
    """List stored subscription URLs from config."""
    try:
        with open(settings.subscriptions_path) as f:
            data = yaml.safe_load(f) or {}
        return data.get("subscriptions", [])
    except FileNotFoundError:
        return []


@router.post("/import")
async def import_subscriptions(
    channels: list[ImportChannel],
    db: AsyncSession = Depends(get_db),
):
    """
    Import channels directly from subscription data
    (data from YouTube Data API subscriptions.list).
    """
    saved = 0
    for ch in channels:
        existing = await db.execute(
            select(Channel).where(Channel.youtube_id == ch.youtube_id)
        )
        exists = existing.scalar_one_or_none()
        if exists:
            exists.title = ch.title
            exists.description = ch.description
            exists.thumbnail_url = ch.thumbnail_url
        else:
            db.add(Channel(
                youtube_id=ch.youtube_id,
                title=ch.title,
                description=ch.description,
                thumbnail_url=ch.thumbnail_url,
                subscriber_count=ch.subscriber_count,
            ))
        # Always update subscriber count on re-import
        if exists:
            exists.subscriber_count = ch.subscriber_count
        saved += 1

    await db.commit()

    # Save IDs to config for cron
    ids = [ch.youtube_id for ch in channels]
    with open(settings.subscriptions_path, "w") as f:
        yaml.dump({"subscriptions": ids}, f, allow_unicode=True)

    return {"saved": saved, "total": len(channels)}


@router.post("/sync-all")
async def sync_all_from_subscriptions(db: AsyncSession = Depends(get_db)):
    """Re-import channels from saved subscription config."""
    try:
        with open(settings.subscriptions_path) as f:
            data = yaml.safe_load(f) or {}
        ids = data.get("subscriptions", [])
    except FileNotFoundError:
        return {"error": "No subscriptions saved. Import first."}

    # Fetch from YouTube API
    import httpx
    from app.auth_google import _get_token
    from google.auth.transport.requests import Request as GoogleRequest

    creds = _get_token()
    if not creds:
        return {"error": "Not authenticated"}
    if creds.expired and creds.refresh_token:
        creds.refresh(GoogleRequest())

    headers = {"Authorization": f"Bearer {creds.token}"}
    channels = []
    async with httpx.AsyncClient(timeout=30.0) as client:
        # Batch 50 IDs per request
        for i in range(0, len(ids), 50):
            batch = ids[i:i + 50]
            resp = await client.get(
                f"https://www.googleapis.com/youtube/v3/channels",
                headers=headers,
                params={"part": "snippet,statistics", "id": ",".join(batch)},
            )
            if resp.status_code != 200:
                print(f"  API error {resp.status_code} for batch {i // 50}")
                continue
            data = resp.json()
            for item in data.get("items", []):
                s = item.get("snippet", {})
                stats = item.get("statistics", {})
                channels.append(ImportChannel(
                    youtube_id=item["id"],
                    title=s.get("title", ""),
                    description=s.get("description", ""),
                    thumbnail_url=s.get("thumbnails", {}).get("default", {}).get("url", ""),
                    subscriber_count=int(stats.get("subscriberCount", 0)),
                ))

    return await import_subscriptions(channels, db)