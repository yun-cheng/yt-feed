from __future__ import annotations

import json

import yaml
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import search_index
from app.categorizer import remove_channels as _remove_channel_groups
from app.database import async_session
from app.models import Channel, ChannelTag, ChannelTagRejection, HiddenChannel, Video
from app.config import settings

router = APIRouter(prefix="/subscriptions")


class ImportChannel(BaseModel):
    youtube_id: str
    title: str = ""
    description: str = ""
    thumbnail_url: str = ""
    subscriber_count: int = 0
    # YouTube topicDetails categories — the backbone for auto-tagging.
    topics: list[str] = []


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
        topics_json = json.dumps(ch.topics) if ch.topics else ""
        if exists:
            exists.title = ch.title
            exists.description = ch.description
            exists.thumbnail_url = ch.thumbnail_url
            # Only overwrite topics when we actually got some — the plain
            # subscriptions.list import doesn't carry them.
            if topics_json:
                exists.topics = topics_json
        else:
            db.add(Channel(
                youtube_id=ch.youtube_id,
                title=ch.title,
                description=ch.description,
                thumbnail_url=ch.thumbnail_url,
                subscriber_count=ch.subscriber_count,
                topics=topics_json,
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
                # topicDetails rides along free — same 1 quota unit as snippet.
                params={"part": "snippet,statistics,topicDetails", "id": ",".join(batch)},
            )
            if resp.status_code != 200:
                print(f"  API error {resp.status_code} for batch {i // 50}")
                continue
            data = resp.json()
            for item in data.get("items", []):
                s = item.get("snippet", {})
                stats = item.get("statistics", {})
                # topicCategories are Wikipedia URLs; keep just the article name.
                cats = item.get("topicDetails", {}).get("topicCategories", [])
                topics = [u.rsplit("/", 1)[-1].replace("_", " ") for u in cats]
                channels.append(ImportChannel(
                    youtube_id=item["id"],
                    title=s.get("title", ""),
                    description=s.get("description", ""),
                    thumbnail_url=s.get("thumbnails", {}).get("default", {}).get("url", ""),
                    subscriber_count=int(stats.get("subscriberCount", 0)),
                    topics=topics,
                ))

    return await import_subscriptions(channels, db)


async def _prune_channels(db: AsyncSession, channel_ids: list[str]) -> dict:
    """Fully delete channels the user is no longer subscribed to.

    Removes each channel's feed data — videos, tag assignments, hidden-channel
    entry, legacy category grouping, the channel row itself, and the matching
    Meilisearch docs. Deliberately leaves the user's own saved data alone
    (downloads / watch-later / playlist items are snapshots keyed by video id,
    with a download row also pointing at a file on disk).
    """
    if not channel_ids:
        return {"channels": [], "videos": 0}

    video_ids = list(
        (
            await db.execute(
                select(Video.youtube_id).where(Video.channel_id.in_(channel_ids))
            )
        ).scalars().all()
    )

    await db.execute(delete(Video).where(Video.channel_id.in_(channel_ids)))
    await db.execute(delete(ChannelTag).where(ChannelTag.channel_id.in_(channel_ids)))
    await db.execute(
        delete(ChannelTagRejection).where(ChannelTagRejection.channel_id.in_(channel_ids))
    )
    await db.execute(delete(HiddenChannel).where(HiddenChannel.channel_id.in_(channel_ids)))
    await db.execute(delete(Channel).where(Channel.youtube_id.in_(channel_ids)))
    await db.commit()

    _remove_channel_groups(channel_ids)
    await search_index.remove_documents(channel_ids=channel_ids, video_ids=video_ids)

    return {"channels": channel_ids, "videos": len(video_ids)}


@router.post("/resync")
async def resync_subscriptions(
    dry_run: bool = Query(default=False, description="preview the prune without deleting"),
    db: AsyncSession = Depends(get_db),
):
    """Sync the DB to your live YouTube subscriptions.

    Fetches the current subscription list over OAuth, then:
    - fully deletes channels (and their videos) you've unsubscribed from,
    - adds/refreshes metadata for everything you're still subscribed to.

    Pass ?dry_run=true to see what would be pruned without touching anything.
    """
    from google.auth.exceptions import GoogleAuthError

    from app.auth_google import fetch_subscriptions as _fetch_live_subs

    try:
        live = (await _fetch_live_subs())["channels"]
    except GoogleAuthError:
        raise HTTPException(
            401, "YouTube auth expired. Re-authenticate at /api/auth/login, then retry."
        )
    live_ids = {c["youtube_id"] for c in live if c.get("youtube_id")}
    # Guard against an API hiccup returning an empty list and wiping everything.
    if not live_ids:
        raise HTTPException(400, "YouTube returned no subscriptions; refusing to prune.")

    existing_rows = (
        await db.execute(select(Channel.youtube_id, Channel.title))
    ).all()
    existing_ids = {r.youtube_id for r in existing_rows}
    titles = {r.youtube_id: r.title for r in existing_rows}

    stale_ids = sorted(existing_ids - live_ids)
    new_ids = sorted(live_ids - existing_ids)

    if dry_run:
        video_count = 0
        if stale_ids:
            video_count = (
                await db.execute(
                    select(func.count())
                    .select_from(Video)
                    .where(Video.channel_id.in_(stale_ids))
                )
            ).scalar_one()
        return {
            "dry_run": True,
            "live_subscriptions": len(live_ids),
            "would_prune_channels": [
                {"youtube_id": cid, "title": titles.get(cid, "")} for cid in stale_ids
            ],
            "would_delete_videos": video_count,
            "would_add_channels": len(new_ids),
        }

    pruned = await _prune_channels(db, stale_ids)

    # Persist the live set, then refresh metadata (incl. subscriber counts for
    # brand-new channels) via the existing channels.list-with-stats path.
    ids = sorted(live_ids)
    with open(settings.subscriptions_path, "w") as f:
        yaml.dump({"subscriptions": ids}, f, allow_unicode=True)
    sync_result = await sync_all_from_subscriptions(db)

    # Auto-tag newly-added channels (sidebar filters) now that sync_all has
    # populated their titles/descriptions.
    tagged = 0
    if new_ids:
        from app.routers.tags import assign_auto_tags

        new_channels = (
            await db.execute(select(Channel).where(Channel.youtube_id.in_(new_ids)))
        ).scalars().all()
        tagged = await assign_auto_tags(db, new_channels)
        await db.commit()

    await search_index.reindex_all()

    return {
        "pruned_channels": len(pruned["channels"]),
        "deleted_videos": pruned["videos"],
        "added_channels": len(new_ids),
        "tags_assigned": tagged,
        "live_subscriptions": len(live_ids),
        "metadata_refresh": sync_result,
    }