"""The chat replay of a finished live stream.

YouTube keeps a stream's chat after it airs, each message stamped with how far
into the stream it was sent, and plays it back beside the recording. yt-dlp
reaches it as a "subtitle" track named `live_chat`: a file of JSON lines, one
per page of chat, walked from the start of the stream to its end. No Data API
and no quota, but not quick — a 3-hour broadcast is 13 MB over ~30 seconds — so
it's fetched once, when someone opens the Chat tab, and kept.

Kept trimmed: a message is its time, its author, the author's role and its
text (with custom emoji as pictures), about a tenth of what YouTube sends. A
replay never changes once the stream is over, so the copy never goes stale.

Live chat for a stream still on air is not this: yt-dlp would follow it until
the broadcast ended. That's YouTube's own embeddable chat's job.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Iterable

from app import ytdl

LANG = "live_chat"

# YouTube's video ids, exactly. They become file names here, so nothing else
# gets near the filesystem.
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def has_replay(info: dict) -> bool:
    """Whether a finished stream's extraction offers a chat replay.

    Only `was_live`: a stream on air lists `live_chat` too, but that one never
    ends (see the module docstring).
    """
    return info.get("live_status") == "was_live" and LANG in (info.get("subtitles") or {})


def download(video_id: str, workdir: str) -> str:
    """Fetch the raw replay into `workdir` and return its path. Blocking.

    The file grows a page at a time as the walk goes (see `covered_ms`), at
    `<id>.live_chat.json.part` until it's complete.
    """
    import yt_dlp

    os.makedirs(workdir, exist_ok=True)
    opts = ytdl.opts(
        skip_download=True,
        writesubtitles=True,
        subtitleslangs=[LANG],
        paths={"home": workdir},
        outtmpl={"default": "%(id)s.%(ext)s"},
    )
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
    path = os.path.join(workdir, f"{video_id}.{LANG}.json")
    if not os.path.exists(path):
        raise RuntimeError("YouTube sent no chat replay for this stream")
    return path


def covered_ms(path: str) -> int:
    """How far into the stream a download in progress has reached.

    Read off the last whole line of the growing file: every page is stamped with
    its offset, and pages arrive in order.
    """
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 65536))
            tail = f.read()
    except OSError:
        return 0
    for line in reversed(tail.splitlines()):
        try:
            return int(json.loads(line)["replayChatItemAction"]["videoOffsetTimeMsec"])
        except (ValueError, KeyError, TypeError):
            continue
    return 0


def _runs(message: dict | None) -> list[Any]:
    """A message's text as runs: plain strings, and custom emoji as
    {"e": picture, "n": name}. A standard emoji is its own character."""
    out: list[Any] = []
    for run in (message or {}).get("runs", []):
        if "text" in run:
            text = run["text"]
            if out and isinstance(out[-1], str):
                out[-1] += text
            else:
                out.append(text)
            continue
        emoji = run.get("emoji")
        if not emoji:
            continue
        if not emoji.get("isCustomEmoji"):
            char = emoji.get("emojiId") or ""
            if out and isinstance(out[-1], str):
                out[-1] += char
            else:
                out.append(char)
            continue
        thumbs = (emoji.get("image") or {}).get("thumbnails") or []
        if thumbs:
            name = ((emoji.get("shortcuts") or [""])[0]) or ""
            out.append({"e": thumbs[-1].get("url", ""), "n": name})
    return out


def _role(item: dict) -> str:
    """The badge that changes how a name is drawn: the channel itself, a
    moderator, or a member. Verified changes nothing about the colour."""
    roles = set()
    for b in item.get("authorBadges", []):
        badge = b.get("liveChatAuthorBadgeRenderer", {})
        icon = (badge.get("icon") or {}).get("iconType")
        if icon == "OWNER":
            roles.add("owner")
        elif icon == "MODERATOR":
            roles.add("mod")
        elif badge.get("customThumbnail"):
            roles.add("member")
    for r in ("owner", "mod", "member"):
        if r in roles:
            return r
    return ""


def _name(item: dict) -> str:
    return ((item.get("authorName") or {}).get("simpleText") or "").strip()


def parse(lines: Iterable[str | bytes]) -> list[dict]:
    """The raw replay, trimmed to what the Chat tab draws.

    Each message is {"t": ms into the stream, "a": author, "r": runs}, plus
    "b": role when there is one, and "p": the amount on a Super Chat. A new
    member's welcome is a message with "m": True. Everything else YouTube sends
    (placeholders for removed messages, banners, the "replay is on" notice) is
    left out.
    """
    out: list[dict] = []
    for line in lines:
        try:
            action = json.loads(line).get("replayChatItemAction") or {}
            t = int(action.get("videoOffsetTimeMsec", 0))
        except (ValueError, AttributeError):
            continue
        for a in action.get("actions", []):
            item = (a.get("addChatItemAction") or {}).get("item") or {}
            if "liveChatTextMessageRenderer" in item:
                m = item["liveChatTextMessageRenderer"]
                msg = {"t": t, "a": _name(m), "r": _runs(m.get("message"))}
            elif "liveChatPaidMessageRenderer" in item:
                m = item["liveChatPaidMessageRenderer"]
                msg = {"t": t, "a": _name(m), "r": _runs(m.get("message")),
                       "p": (m.get("purchaseAmountText") or {}).get("simpleText", "")}
            elif "liveChatMembershipItemRenderer" in item:
                m = item["liveChatMembershipItemRenderer"]
                msg = {"t": t, "a": _name(m), "r": _runs(m.get("headerSubtext")), "m": True}
            else:
                continue
            if not msg["r"] and "p" not in msg:
                continue
            role = _role(m)
            if role:
                msg["b"] = role
            out.append(msg)
    out.sort(key=lambda m: m["t"])
    return out
