from __future__ import annotations

import json
from datetime import datetime

import yaml
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth, search_index, users
from app.categorizer import remove_channels as _remove_channel_groups
from app.database import async_session
from app.models import (
    Channel, ChannelTag, ChannelTagRejection, HiddenChannel, User, UserChannel, Video,
)
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


def _write_subscriptions(ids: list[str]) -> None:
    """Keep config/subscriptions.yaml in step with the database.

    It stopped being the subscription list — `user_channels` is, because one
    person's list in a global file has no answer for a second person. This is
    now a written-only mirror, kept for the moment because it's the file you'd
    look at to see what the app thinks you follow, and because a hand-editable
    copy has rescued more than one bad resync.
    """
    with open(settings.subscriptions_path, "w") as f:
        yaml.dump({"subscriptions": ids}, f, allow_unicode=True)


@router.get("")
async def list_subscriptions(
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """The channels you follow."""
    return sorted(await users.held_channel_ids(db, user))


@router.post("/import")
async def import_subscriptions(
    channels: list[ImportChannel],
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """
    Import channels directly from subscription data
    (data from YouTube Data API subscriptions.list).

    Writes two things: the channel row, which is catalog and shared with everyone
    who follows it, and this person's membership. `Channel.source` is still
    written alongside `UserChannel.source` because the channel pages read it to
    draw their badge; `user_channels` is the one the resync prune trusts.
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
            # Subscribing on YouTube to a channel you'd added by hand makes it a
            # subscription: it's in the live list now, so the resync exemption
            # above should stop applying to it.
            exists.source = "subscription"
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
        await users.hold(db, user, ch.youtube_id, source="subscription")
        saved += 1

    await db.commit()

    _write_subscriptions(sorted(await users.held_channel_ids(db, user)))

    return {"saved": saved, "total": len(channels)}


@router.post("/sync-all")
async def sync_all_from_subscriptions(
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Refresh metadata for every channel this person follows."""
    ids = sorted(await users.held_channel_ids(db, user))
    if not ids:
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

    return await import_subscriptions(channels, user, db)


async def _prune_channels(
    db: AsyncSession, user: User, channel_ids: list[str]
) -> dict:
    """Stop following these channels, and delete the ones nobody else holds.

    Two steps that used to be one. Unsubscribing dropped the channel, its videos,
    its tags and its search documents outright — correct when the app had one
    person in it, and somebody else's feed being deleted once it has two. So the
    membership always goes, and the catalog only follows it when the last holder
    lets go.

    Either way this leaves your own saved data alone: downloads, watch-later and
    playlist items are snapshots keyed by video id, with a download row also
    pointing at a file on disk.
    """
    if not channel_ids:
        return {"channels": [], "videos": 0, "released": 0}

    released = await users.release(db, user, channel_ids)
    # Your own opinions about a channel go with your membership, whether or not
    # anyone else still holds it: a tag on a channel that has left your feed
    # would keep padding your sidebar counts with videos you can't see.
    for model in (ChannelTag, ChannelTagRejection, HiddenChannel):
        await db.execute(delete(model).where(
            model.user_id == user.id, model.channel_id.in_(channel_ids)
        ))
    await db.commit()

    doomed = await users.orphaned_channel_ids(db, channel_ids)
    if not doomed:
        return {"channels": [], "videos": 0, "released": released}

    video_ids = list(
        (
            await db.execute(
                select(Video.youtube_id).where(Video.channel_id.in_(doomed))
            )
        ).scalars().all()
    )

    await db.execute(delete(Video).where(Video.channel_id.in_(doomed)))
    await db.execute(delete(ChannelTag).where(ChannelTag.channel_id.in_(doomed)))
    await db.execute(
        delete(ChannelTagRejection).where(ChannelTagRejection.channel_id.in_(doomed))
    )
    await db.execute(delete(HiddenChannel).where(HiddenChannel.channel_id.in_(doomed)))
    await db.execute(delete(Channel).where(Channel.youtube_id.in_(doomed)))
    await db.commit()

    _remove_channel_groups(doomed)
    await search_index.remove_documents(channel_ids=doomed, video_ids=video_ids)

    return {"channels": doomed, "videos": len(video_ids), "released": released}


@router.post("/resync")
async def resync_subscriptions(
    dry_run: bool = Query(default=False, description="preview the prune without deleting"),
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Sync your channel list to your live YouTube subscriptions.

    Fetches the current subscription list over OAuth, then:
    - stops following the channels you've unsubscribed from, deleting each one's
      videos only if nobody else here follows it,
    - adds/refreshes metadata for everything you're still subscribed to.

    Reconciles ONE person's list. What's "stale" is what they hold and YouTube no
    longer lists, so another account's channels are never in scope — which is
    what stops your resync from touching their feed.

    Pass ?dry_run=true to see what would be pruned without touching anything.
    """
    from google.auth.exceptions import GoogleAuthError

    from app.auth_google import fetch_subscriptions as _fetch_live_subs

    # The live list comes from the machine's single YouTube token, which belongs
    # to one account (`users.owner_id`). Reconciling anyone else's channels
    # against it would compare their list to somebody else's subscriptions —
    # pruning everything they hold that the token's owner doesn't, and handing
    # them the owner's whole list in exchange. Refuse rather than do that; per
    # -user resync waits on per-user tokens.
    owner = await users.owner_id(db)
    if owner is not None and user.id != owner:
        raise HTTPException(
            400,
            "Only the account that authorized YouTube can resync — this app "
            "holds a single YouTube token. Add or remove channels by hand.",
        )

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

    held_rows = (await db.execute(
        select(UserChannel.channel_id, UserChannel.source, Channel.title)
        .join(Channel, Channel.youtube_id == UserChannel.channel_id, isouter=True)
        .where(UserChannel.user_id == user.id)
    )).all()
    existing_ids = {r.channel_id for r in held_rows}
    titles = {r.channel_id: r.title or "" for r in held_rows}
    # Channels you added by hand are not subscriptions and will never appear in
    # the live list — so "not in the live list" can't mean "delete it" for them.
    # Without this, adding a channel and then syncing would silently undo it.
    manual_ids = {r.channel_id for r in held_rows if r.source == "manual"}

    stale_ids = sorted(existing_ids - live_ids - manual_ids)
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

    pruned = await _prune_channels(db, user, stale_ids)

    # Take the memberships first, so a metadata fetch that dies halfway leaves a
    # complete list of what you follow rather than a partial one. Everything
    # `sync_all` does after this is refresh, not membership.
    for channel_id in new_ids:
        await users.hold(db, user, channel_id, source="subscription")
    user.last_resync_at = datetime.utcnow()
    await db.commit()

    ids = sorted(live_ids)
    _write_subscriptions(ids)
    # Refresh metadata (incl. subscriber counts for brand-new channels) via the
    # existing channels.list-with-stats path.
    sync_result = await sync_all_from_subscriptions(user, db)
    # sync_all → import_subscriptions rewrites the mirror file from the channels
    # the Data API actually returned, and that call SKIPS a batch that errors —
    # so a transient hiccup would silently drop those ids from it. Restore the
    # full live set; it, not a partial fetch, is the subscription list.
    _write_subscriptions(ids)

    # Auto-tag newly-added channels (sidebar filters) now that sync_all has
    # populated their titles/descriptions.
    tagged = 0
    if new_ids:
        from app.routers.tags import assign_auto_tags

        new_channels = (
            await db.execute(select(Channel).where(Channel.youtube_id.in_(new_ids)))
        ).scalars().all()
        tagged = await assign_auto_tags(db, new_channels, user.id)
        await db.commit()

    await search_index.reindex_all()

    return {
        "unfollowed_channels": pruned["released"],
        "pruned_channels": len(pruned["channels"]),
        "deleted_videos": pruned["videos"],
        "added_channels": len(new_ids),
        "tags_assigned": tagged,
        "live_subscriptions": len(live_ids),
        "metadata_refresh": sync_result,
    }