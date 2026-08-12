"""Playlists — user-created video collections (server-side, YouTube-style)."""

import asyncio
import re
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlparse

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth, quota, users, youtube_api
from app.database import async_session
from app.models import Playlist, PlaylistItem, User, Video
# See watch_later.py — the module, not the function, so a monkeypatch reaches it.
from app.routers import imported

router = APIRouter(prefix="/playlists")


async def get_db():
    async with async_session() as session:
        yield session


class PlaylistCreate(BaseModel):
    name: str


class PlaylistRename(BaseModel):
    name: str


class VideoPayload(BaseModel):
    youtube_id: str
    title: str = ""
    channel_id: str = ""
    channel_name: str = ""
    channel_thumbnail: str = ""
    thumbnail_url: str = ""
    duration_seconds: int = 0
    published_at: str = ""
    view_count: int = 0
    like_count: int = 0
    score: float = 0.0


async def _owned(db: AsyncSession, user: User, playlist_id: int) -> Playlist:
    """This person's playlist, or 404.

    `playlist_items` carries no owner of its own — an item belongs to whoever
    owns the playlist it's in, and a second copy of that could disagree with it.
    So every route that names a playlist id passes through here first, and item
    access is decided once, in one place.

    Somebody else's playlist is "not found" rather than "not yours": a 403 would
    confirm the id exists, which is more than the asker should learn.
    """
    p = await db.get(Playlist, playlist_id)
    if p is None or p.user_id != user.id:
        raise HTTPException(404, "Playlist not found")
    return p


def _video_dict(it: PlaylistItem) -> dict:
    return {
        # When it joined THIS list. Named `created_at` rather than `added_at`
        # because that's what the same moment is called on Watch Later, Imported
        # and Downloads, and one name lets one accessor serve every library page.
        "created_at": it.added_at.isoformat() if it.added_at else None,
        "youtube_id": it.youtube_id,
        "title": it.title,
        "channel_id": it.channel_id,
        "channel_name": it.channel_name,
        "channel_thumbnail": it.channel_thumbnail or "",
        "thumbnail_url": it.thumbnail_url,
        "duration_seconds": it.duration_seconds,
        "published_at": it.published_at,
        "view_count": it.view_count,
        "like_count": it.like_count,
        "score": it.score,
    }


@router.get("")
async def list_playlists(
    user: User = Depends(auth.account), db: AsyncSession = Depends(get_db)
):
    """All playlists with item count + a cover thumbnail (newest item)."""
    playlists = (await db.execute(
        select(Playlist)
        .where(Playlist.user_id == user.id)
        .order_by(Playlist.created_at.desc())
    )).scalars().all()

    # counts per playlist
    counts = dict((await db.execute(
        select(PlaylistItem.playlist_id, func.count())
        .join(Playlist, Playlist.id == PlaylistItem.playlist_id)
        .where(Playlist.user_id == user.id)
        .group_by(PlaylistItem.playlist_id)
    )).all())

    out = []
    for p in playlists:
        cover = (await db.execute(
            select(PlaylistItem.thumbnail_url)
            .where(PlaylistItem.playlist_id == p.id)
            .order_by(PlaylistItem.added_at.desc())
            .limit(1)
        )).scalar_one_or_none()
        out.append({
            "id": p.id,
            "name": p.name,
            "item_count": counts.get(p.id, 0),
            "thumbnail_url": cover or "",
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "youtube_id": p.youtube_id or "",
            "synced_at": p.synced_at.isoformat() if p.synced_at else None,
        })
    return out


@router.post("")
async def create_playlist(
    body: PlaylistCreate,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    name = body.name.strip() or "New playlist"
    p = Playlist(user_id=user.id, name=name, created_at=datetime.utcnow())
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return {"id": p.id, "name": p.name, "item_count": 0, "thumbnail_url": ""}


@router.patch("/{playlist_id}")
async def rename_playlist(
    playlist_id: int,
    body: PlaylistRename,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    p = await _owned(db, user, playlist_id)
    p.name = body.name.strip() or p.name
    await db.commit()
    return {"id": p.id, "name": p.name}


@router.delete("/{playlist_id}")
async def delete_playlist(
    playlist_id: int,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    await _owned(db, user, playlist_id)
    await db.execute(delete(PlaylistItem).where(PlaylistItem.playlist_id == playlist_id))
    await db.execute(delete(Playlist).where(Playlist.id == playlist_id))
    await db.commit()
    return {"status": "ok"}


@router.get("/containing/{youtube_id}")
async def playlists_containing(
    youtube_id: str,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """IDs of playlists that already contain this video (for the save-to menu)."""
    rows = (await db.execute(
        select(PlaylistItem.playlist_id)
        .join(Playlist, Playlist.id == PlaylistItem.playlist_id)
        .where(Playlist.user_id == user.id, PlaylistItem.youtube_id == youtube_id)
        .distinct()
    )).all()
    return [r[0] for r in rows]


# --- Importing from YouTube -------------------------------------------------
#
# Three ways in, because they reach different things.
#
# LISTING (`/youtube`) is bulk and one click, and belongs to the owner alone —
# this machine holds a single YouTube token, so listing "my playlists" for anyone
# else would hand them the owner's. Its limit is narrower than it looks:
# `playlists.list?mine=true` returns playlists that account CREATED, and YouTube
# exposes no endpoint at all for the ones you SAVED from other people. That
# library simply isn't in the Data API.
#
# NAMING (`/youtube/lookup`, then `/import`) fills that hole. Both
# `playlists.list?id=` and `playlistItems.list` read any PUBLIC playlist, owner
# or not — so one that can't be enumerated can still be pasted.
#
# CARRYING (`/import-external`) takes the videos in the request body: the browser
# already read them off the page as whoever is signed in there. That's the only
# route to Watch Later, to Liked Videos, and to anyone's PRIVATE playlist — none
# of which the two above can touch at any price — and the only route at all for a
# household member with no Google connection.


class ImportRequest(BaseModel):
    youtube_id: str
    name: str = ""


# A playlist id as it appears in a URL: `PL…` for an ordinary one, `UU…` for a
# channel's uploads, `FL…` for a favourites list, `OLAK5uy_…` for an auto-
# generated album, and the bare `WL` / `LL`. Rather than enumerate prefixes that
# YouTube keeps adding to, accept the character set and let the API decide
# whether it names anything.
_PLAYLIST_ID = re.compile(r"^[A-Za-z0-9_-]{2,64}$")


def playlist_ref(text: str) -> str:
    """The playlist id in whatever the user pasted, or "".

    Takes a full URL (`…/playlist?list=PL…`, or a watch URL that happens to
    carry a `list=`), or a bare id. A watch URL counts on purpose: "add the
    playlist this video is in" is a reasonable reading of pasting one, and the
    alternative is refusing a link that plainly contains the answer.
    """
    text = (text or "").strip()
    if not text:
        return ""
    if "list=" in text:
        try:
            found = parse_qs(urlparse(text).query).get("list", [""])[0]
        except ValueError:
            return ""
        return found if _PLAYLIST_ID.match(found) else ""
    return text if _PLAYLIST_ID.match(text) else ""


class ExternalImport(BaseModel):
    """A playlist the browser read for us. See `import_external`."""
    youtube_id: str = ""
    name: str = ""
    videos: list[VideoPayload] = []


class _AvatarRow:
    """Adapter letting `fill_channel_avatars` work on a plain dict.

    It takes anything carrying `channel_id` and `channel_thumbnail` because every
    snapshot TABLE has those two columns — but here the avatars have to be
    resolved before any row exists. See `_enrich` for why.
    """

    __slots__ = ("channel_id", "channel_thumbnail")

    def __init__(self, video: dict):
        self.channel_id = video.get("channel_id") or ""
        self.channel_thumbnail = video.get("channel_thumbnail") or ""


async def _enrich(db: AsyncSession, videos: list[dict]) -> list[dict]:
    """Everything that talks to YouTube, done before anything is written.

    Two top-ups: duration/views/likes, which `playlistItems.list` doesn't carry
    and without which a card reads as broken, and the uploader's avatar.

    **This must run before the first write of the request**, and the reason is
    sharper than tidiness. Both calls end by recording what they spent to
    `quota_ledger`, through a session of their own. SQLite allows one writer: if
    the request's own session has already flushed — which creating the playlist
    row does — it holds the write lock, and the ledger update blocks against it
    until the whole import dies with "database is locked". Fetching first also
    means a playlist that fails to load leaves nothing behind.

    Best-effort throughout: the stats fetcher keeps an hour-long cache and
    returns nothing for an id it fetched recently, so a video the feed already
    knows simply keeps the numbers it has.
    """
    ids = [v["youtube_id"] for v in videos if v.get("youtube_id")]
    if not ids:
        return videos

    rows = [_AvatarRow(v) for v in videos]
    await imported.fill_channel_avatars(rows, db)
    for v, row in zip(videos, rows):
        if row.channel_thumbnail:
            v["channel_thumbnail"] = row.channel_thumbnail

    # What the feed already holds, first — free, and it fixes a real hole.
    #
    # `batch_fetch_video_stats` keeps an hour-long cache and returns NOTHING for
    # an id it fetched recently. For the feed that's harmless: those rows already
    # carry their numbers. But a row arriving from the extension carries none —
    # a playlist page gives up no view count and no publish date — so a video the
    # scan happened to touch in the last hour would keep a blank view count and
    # no date for good. Reading `videos` costs a query and closes it.
    known = {
        r[0]: r for r in await db.execute(
            select(
                Video.youtube_id, Video.title, Video.view_count, Video.like_count,
                Video.duration_seconds, Video.published_at, Video.thumbnail_url,
            ).where(Video.youtube_id.in_(ids))
        )
    }
    for v in videos:
        row = known.get(v["youtube_id"])
        if row is None:
            continue
        _, title, views, likes, secs, published, thumb = row
        if secs and not v.get("duration_seconds"):
            v["duration_seconds"] = secs
        if views and not v.get("view_count"):
            v["view_count"] = views
        if likes and not v.get("like_count"):
            v["like_count"] = likes
        if thumb and not v.get("thumbnail_url"):
            v["thumbnail_url"] = thumb
        if published and not v.get("published_at"):
            v["published_at"] = published.isoformat()
        # The title is the one field the local row OVERRIDES rather than fills.
        # See `_enrich`'s note below — same reason, same rule.
        if title:
            v["title"] = title

    loop = asyncio.get_event_loop()
    try:
        stats = await loop.run_in_executor(
            None, youtube_api.batch_fetch_video_stats, ids
        )
    except youtube_api.QuotaExceeded:
        return videos  # the import still lands, just without the numbers
    finally:
        await quota.record(youtube_api.take_quota_delta())

    # Only ever fill a gap, never overwrite. The extension's importer reads a
    # duration straight off the page, and a partial answer from here — 0 views
    # for a video the cache declined to refetch — would replace something true
    # with something wrong.
    for v in videos:
        s = stats.get(v["youtube_id"])
        if not s:
            continue
        for key in ("duration_seconds", "view_count", "like_count", "thumbnail_url"):
            if s.get(key) and not v.get(key):
                v[key] = s[key]

        # The title OVERRIDES rather than fills, and it's the only field that
        # does. Two reasons, and the second is the one that matters:
        #
        # A YouTube playlist page truncates every title to 100 characters, so
        # the extension's importer physically cannot read a long one in full.
        #
        # More importantly this lookup asks for `hl=zh-TW` and prefers the
        # LOCALIZED title, which is what the rest of the app shows. The page
        # gives whatever language the browser was in — so the two aren't a long
        # and a short version of one string, they're different strings. Picking
        # the longer one would show a 100-character English title next to the
        # Chinese one the feed shows for the same video.
        if s.get("title"):
            v["title"] = s["title"]
        # And the page carries a relative date ("2 years ago") that isn't one.
        if s.get("published_at") and not v.get("published_at"):
            v["published_at"] = s["published_at"].isoformat()
    return videos


async def _merge(db: AsyncSession, playlist: Playlist, videos: list[dict]) -> int:
    """Add what isn't already there. Returns how many rows were new.

    Add-only, on purpose. A video that left the YouTube playlist stays in your
    copy: this is an import, and a sync that quietly deleted things you'd kept
    would be a worse tool than one that occasionally leaves something behind.
    Re-syncing is therefore always safe, which is what makes it a button.

    Playlist order is preserved by spacing `added_at` a second apart descending,
    because `get_playlist` sorts newest-first and there's no position column to
    sort by instead. A re-sync anchors at a later "now", so videos found later
    sit above the original import rather than at the end of it.
    """
    have = {r[0] for r in await db.execute(
        select(PlaylistItem.youtube_id).where(
            PlaylistItem.playlist_id == playlist.id
        )
    )}
    fresh = [v for v in videos if v.get("youtube_id") and v["youtube_id"] not in have]
    if not fresh:
        return 0

    now = datetime.utcnow()
    items = []
    for i, v in enumerate(fresh):
        items.append(PlaylistItem(
            playlist_id=playlist.id,
            added_at=now - timedelta(seconds=i),
            youtube_id=v["youtube_id"],
            title=v.get("title") or "",
            channel_id=v.get("channel_id") or "",
            channel_name=v.get("channel_name") or "",
            channel_thumbnail=v.get("channel_thumbnail") or "",
            thumbnail_url=v.get("thumbnail_url") or "",
            duration_seconds=v.get("duration_seconds") or 0,
            published_at=v.get("published_at") or "",
            view_count=v.get("view_count") or 0,
            like_count=v.get("like_count") or 0,
            score=v.get("score") or 0.0,
        ))
    # No network call here, deliberately — `_enrich` has already resolved the
    # avatars. Everything from this point is a local write.
    db.add_all(items)
    return len(items)


async def _owner_only(db: AsyncSession, user: User) -> None:
    """Refuse anyone but the account that authorized YouTube.

    Same reasoning as the subscription resync: the machine holds one token, so
    "my playlists" would hand this person the owner's list whatever account they
    signed in as. The extension importer is what everyone else uses, and it needs
    no token at all.
    """
    owner = await users.owner_id(db)
    if owner is not None and user.id != owner:
        raise HTTPException(
            400,
            "Only the account that authorized YouTube can import from it — this "
            "app holds a single YouTube token. Use the browser extension's "
            "\"Import to YT Feed\" button on a playlist page instead.",
        )


@router.get("/youtube")
async def list_youtube_playlists(
    user: User = Depends(auth.account), db: AsyncSession = Depends(get_db)
):
    """The owner's YouTube playlists, each marked with the local copy it has.

    `linked_id` is what turns a second import into a re-sync — the dialog offers
    "Re-sync" rather than "Import" for a playlist already brought over, so
    clicking twice can't leave two copies.
    """
    await _owner_only(db, user)
    loop = asyncio.get_event_loop()
    try:
        found = await loop.run_in_executor(None, youtube_api.fetch_my_playlists)
    except youtube_api.QuotaExceeded:
        raise HTTPException(
            429, "YouTube's daily quota is spent. It resets at midnight Pacific."
        )
    finally:
        await quota.record(youtube_api.take_quota_delta())

    linked = dict((await db.execute(
        select(Playlist.youtube_id, Playlist.id).where(
            Playlist.user_id == user.id, Playlist.youtube_id != ""
        )
    )).all())
    for p in found:
        p["linked_id"] = linked.get(p["youtube_id"])
    return found


@router.get("/youtube/lookup")
async def lookup_youtube_playlist(
    ref: str = Query(description="a playlist URL, a watch URL carrying one, or a bare id"),
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Preview any public playlist by link, including one you don't own.

    This is the answer to the hole in `/youtube`: that lists playlists your
    account CREATED, and YouTube exposes no endpoint for the playlists you saved
    from other people. But `playlists.list?id=` and `playlistItems.list` both
    work on anything public, so a playlist that can't be *enumerated* can still
    be *named* — and pasting its link is how you name it.

    Look up, look at what came back, then import — the same two-step as adding a
    channel, and for the same reason: a link is easy to paste wrong, and a title
    and an owner answer "is this the one I meant?" before anything is written.
    """
    await _owner_only(db, user)
    yt_id = playlist_ref(ref)
    if not yt_id:
        raise HTTPException(400, "That doesn't look like a playlist link or id.")

    loop = asyncio.get_event_loop()
    try:
        found = await loop.run_in_executor(
            None, youtube_api.fetch_playlist_details, yt_id
        )
    except youtube_api.QuotaExceeded:
        raise HTTPException(
            429, "YouTube's daily quota is spent. It resets at midnight Pacific."
        )
    finally:
        await quota.record(youtube_api.take_quota_delta())

    if found is None:
        raise HTTPException(
            404,
            "No public playlist with that id. A private one can't be read this "
            "way — open it on youtube.com and use the extension's \"Import to "
            "YT Feed\" button, which reads the page as you.",
        )

    found["linked_id"] = (await db.execute(
        select(Playlist.id).where(
            Playlist.user_id == user.id, Playlist.youtube_id == found["youtube_id"]
        )
    )).scalars().first()
    return found


@router.post("/import")
async def import_playlist(
    body: ImportRequest,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Copy one YouTube playlist here and remember where it came from.

    Importing something already imported re-syncs that copy instead of making a
    second one — the same thing `/{id}/resync` does, reached from the other side.
    """
    await _owner_only(db, user)
    # Accepts a pasted link as readily as a bare id, so the lookup above can
    # hand its answer straight back and a caller with only a URL needn't parse.
    yt_id = playlist_ref(body.youtube_id)
    if not yt_id:
        raise HTTPException(400, "That doesn't look like a playlist link or id.")

    # Read from YouTube BEFORE creating anything — see `_enrich`. Creating the
    # playlist first would hold SQLite's write lock across the quota ledger's
    # own write and deadlock the request, and would leave an empty playlist
    # behind whenever the read failed.
    videos = await _fetch(db, yt_id)

    playlist = (await db.execute(
        select(Playlist).where(
            Playlist.user_id == user.id, Playlist.youtube_id == yt_id
        )
    )).scalars().first()
    if playlist is None:
        playlist = Playlist(
            user_id=user.id,
            name=body.name.strip() or "Imported playlist",
            youtube_id=yt_id,
            created_at=datetime.utcnow(),
        )
        db.add(playlist)
        await db.flush()

    added = await _merge(db, playlist, videos)
    playlist.synced_at = datetime.utcnow()
    await db.commit()
    return {"id": playlist.id, "name": playlist.name, "added": added}


@router.post("/{playlist_id}/resync")
async def resync_playlist(
    playlist_id: int,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Pull anything new from the YouTube playlist this one was imported from."""
    playlist = await _owned(db, user, playlist_id)
    if not playlist.youtube_id:
        raise HTTPException(400, "This playlist wasn't imported from YouTube.")
    await _owner_only(db, user)
    videos = await _fetch(db, playlist.youtube_id)
    added = await _merge(db, playlist, videos)
    playlist.synced_at = datetime.utcnow()
    await db.commit()
    return {"id": playlist.id, "name": playlist.name, "added": added}


async def _fetch(db: AsyncSession, yt_id: str) -> list[dict]:
    """One YouTube playlist, read and enriched. No writes — see `_enrich`."""
    loop = asyncio.get_event_loop()
    try:
        videos = await loop.run_in_executor(
            None, youtube_api.fetch_playlist_items, yt_id
        )
    except youtube_api.QuotaExceeded:
        raise HTTPException(
            429, "YouTube's daily quota is spent. It resets at midnight Pacific."
        )
    finally:
        await quota.record(youtube_api.take_quota_delta())

    if not videos:
        raise HTTPException(
            404,
            "Nothing importable in that playlist — every entry is private or "
            "deleted, or YouTube won't serve it. Watch Later and Liked Videos "
            "are the second case; import those with the browser extension.",
        )
    return await _enrich(db, videos)


@router.post("/import-external")
async def import_external(
    body: ExternalImport,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Take a playlist the browser read for us.

    No YouTube token involved on this side, which is the point: it works for
    every account here, and reaches the playlists the API won't hand over. The
    caller is whoever the request authenticates as — the extension's API key —
    so nobody can import into someone else's playlists.

    Idempotent by `youtube_id` the same way `/import` is, and empty-safe: a page
    the extension couldn't read yields no videos, and creating an empty playlist
    from that would just be litter to clean up.
    """
    if not body.videos:
        raise HTTPException(400, "No videos in that playlist — nothing to import.")

    yt_id = body.youtube_id.strip()

    # Before the playlist row, for the same two reasons `/import` does it in this
    # order — see `_enrich`. Worth a quota unit per 50 even though the page
    # already gave us most of it: what the browser reads off a playlist card is
    # the title, channel, thumbnail and duration, and this fills what's left —
    # the view and like counts, and the titles YouTube truncated to 100 chars.
    videos = await _enrich(db, [v.model_dump() for v in body.videos])

    playlist = None
    if yt_id:
        playlist = (await db.execute(
            select(Playlist).where(
                Playlist.user_id == user.id, Playlist.youtube_id == yt_id
            )
        )).scalars().first()
    if playlist is None:
        playlist = Playlist(
            user_id=user.id,
            name=body.name.strip() or "Imported playlist",
            youtube_id=yt_id,
            created_at=datetime.utcnow(),
        )
        db.add(playlist)
        await db.flush()

    added = await _merge(db, playlist, videos)
    playlist.synced_at = datetime.utcnow()
    await db.commit()
    return {"id": playlist.id, "name": playlist.name, "added": added}


@router.get("/{playlist_id}")
async def get_playlist(
    playlist_id: int,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    p = await _owned(db, user, playlist_id)
    items = (await db.execute(
        select(PlaylistItem)
        .where(PlaylistItem.playlist_id == playlist_id)
        .order_by(PlaylistItem.added_at.desc())
    )).scalars().all()
    return {
        "id": p.id,
        "name": p.name,
        "youtube_id": p.youtube_id or "",
        "synced_at": p.synced_at.isoformat() if p.synced_at else None,
        "videos": [_video_dict(it) for it in items],
    }


@router.post("/{playlist_id}/items")
async def add_item(
    playlist_id: int,
    video: VideoPayload,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    await _owned(db, user, playlist_id)
    exists = (await db.execute(
        select(PlaylistItem).where(
            PlaylistItem.playlist_id == playlist_id,
            PlaylistItem.youtube_id == video.youtube_id,
        )
    )).scalar_one_or_none()
    if exists is None:
        item = PlaylistItem(playlist_id=playlist_id, added_at=datetime.utcnow(), **video.model_dump())
        db.add(item)
        await imported.fill_channel_avatars([item], db)
        await db.commit()
    return {"status": "ok"}


@router.delete("/{playlist_id}/items/{youtube_id}")
async def remove_item(
    playlist_id: int,
    youtube_id: str,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    await _owned(db, user, playlist_id)
    await db.execute(delete(PlaylistItem).where(
        PlaylistItem.playlist_id == playlist_id,
        PlaylistItem.youtube_id == youtube_id,
    ))
    await db.commit()
    return {"status": "ok"}
