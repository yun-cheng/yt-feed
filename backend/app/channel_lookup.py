"""Turning whatever you pasted into a channel.

The feed is built from channels, and until now the only door into that table was
your YouTube subscription list. This is the other door: a link, a handle, or a
bare id becomes the same `channels` row a subscription would have produced.

Two resolvers, cheapest first. The Data API answers an id or an @handle for one
quota unit and brings `topicDetails` with it, which is what the auto-tagger
reads. yt-dlp answers anything at all — including the legacy /c/ and /user/ URLs
the API has no field for — and needs no credentials, so it also covers the day
the token has expired. Neither writes anything: see routers/channels.py for the
endpoint that saves what this finds.
"""

from __future__ import annotations

import asyncio
import re
from functools import partial
from typing import Any

from app import quota
from app.youtube_api import QuotaExceeded, fetch_channel_details, take_quota_delta

# A channel id is exactly "UC" plus 22 URL-safe characters. Worth matching
# precisely: it's what tells a pasted id apart from a pasted handle.
_ID_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")

# The three URL shapes YouTube has used for a channel, in one pass. /channel/
# carries the id itself; /@handle is the current form; /c/ and /user/ are the
# old vanity URLs, which only yt-dlp can resolve.
_URL_RE = re.compile(
    r"youtube\.com/(?:"
    r"channel/(?P<id>UC[A-Za-z0-9_-]{22})"
    r"|(?P<handle>@[A-Za-z0-9_.\-]+)"
    r"|(?:c|user)/(?P<legacy>[^/?#\s]+)"
    r")",
    re.IGNORECASE,
)

_YOUTUBE = "https://www.youtube.com"


def parse_channel_query(raw: str) -> dict[str, str]:
    """What the input identifies the channel by: {channel_id|handle, url}.

    Empty dict when it isn't a channel reference at all. A bare word is read as
    a handle, because that's what someone typing rather than pasting means — and
    it costs one lookup that comes back empty if it isn't.
    """
    q = (raw or "").strip()
    if not q:
        return {}

    m = _URL_RE.search(q)
    if m:
        if m.group("id"):
            return {"channel_id": m.group("id"), "url": f"{_YOUTUBE}/channel/{m.group('id')}"}
        if m.group("handle"):
            handle = m.group("handle")
            return {"handle": handle, "url": f"{_YOUTUBE}/{handle}"}
        # A vanity URL has no id and no handle in it — hand the whole thing to
        # yt-dlp, which is the only one of the two that can follow it.
        return {"url": f"{_YOUTUBE}/{m.group(0).split('youtube.com/', 1)[1]}"}

    # Not a URL: a bare id, or a handle with or without its @.
    if _ID_RE.match(q):
        return {"channel_id": q, "url": f"{_YOUTUBE}/channel/{q}"}
    if re.fullmatch(r"@?[A-Za-z0-9_.\-]+", q):
        handle = q if q.startswith("@") else f"@{q}"
        return {"handle": handle, "url": f"{_YOUTUBE}/{handle}"}
    return {}


def _avatar(info: dict) -> str:
    """The channel's picture out of a yt-dlp channel extraction.

    A channel carries `avatar_uncropped` among its thumbnails (a video does not
    — see imported._channel_thumb). Anything else with "avatar" in its id is
    taken as a fallback, since the exact id has changed before.
    """
    thumbs = info.get("thumbnails") or []
    for want_exact in (True, False):
        for t in thumbs:
            tid = str(t.get("id") or "")
            if (tid == "avatar_uncropped") if want_exact else ("avatar" in tid):
                if t.get("url"):
                    return t["url"]
    return ""


def _extract_channel(url: str) -> dict[str, Any] | None:
    """Blocking yt-dlp channel lookup. Runs in an executor.

    `playlist_items: "1"` because we want the channel, not its uploads — without
    it this walks the whole video list to answer a question about the header.
    """
    import yt_dlp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "playlist_items": "1",
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        print(f"[channel_lookup] {url}: {e}")
        return None

    channel_id = info.get("channel_id") or info.get("uploader_id") or ""
    if not _ID_RE.match(channel_id):
        return None
    return {
        "youtube_id": channel_id,
        # `title` on a channel extraction is the tab's name ("Name - Videos"),
        # so prefer the channel field and only fall back to it.
        "title": info.get("channel") or info.get("title") or "",
        "description": info.get("description") or "",
        "thumbnail_url": _avatar(info),
        "subscriber_count": int(info.get("channel_follower_count") or 0),
        # yt-dlp has no equivalent of topicDetails. An empty list means the
        # auto-tagger works from the title and description alone.
        "topics": [],
    }


async def resolve_channel(raw: str) -> dict[str, Any] | None:
    """Find the channel `raw` refers to, without saving anything.

    Returns the same fields a subscription import carries, or None if nothing
    resolved. Never raises for an unresolvable input — "no such channel" is an
    everyday answer here, not an error.
    """
    parsed = parse_channel_query(raw)
    if not parsed:
        return None

    loop = asyncio.get_event_loop()
    info = None

    if parsed.get("channel_id") or parsed.get("handle"):
        try:
            info = await loop.run_in_executor(None, partial(
                fetch_channel_details,
                channel_id=parsed.get("channel_id", ""),
                handle=parsed.get("handle", ""),
            ))
        except QuotaExceeded:
            # Out of allowance, not out of options — yt-dlp below costs nothing.
            pass
        finally:
            # Against the day but not the archive's share: looking a channel up
            # is incidental to adding one, and must not eat the fetching budget.
            await quota.record(take_quota_delta(), archive=False)

    if info is None:
        info = await loop.run_in_executor(None, _extract_channel, parsed["url"])
    return info
