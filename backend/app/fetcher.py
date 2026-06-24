"""
yt-dlp wrapper — fetches subscriptions, channel info, and latest videos.

All calls use yt-dlp's --dump-json mode, which bypasses YouTube Data API quota.
"""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from typing import Any

import yt_dlp


def _run_ytdlp(url: str, **extra_opts) -> list[dict[str, Any]]:
    """Run yt-dlp and return parsed JSON output."""
    opts = {
        "quiet": True,
        "skip_download": True,
        "dump_single_json": False,
        "ignoreerrors": True,
        "no_warnings": True,
        "extractor_args": {"youtube": {"skip": ["dash", "hls"]}},
    }
    opts.update(extra_opts)

    ydl = yt_dlp.YoutubeDL(opts)
    info = ydl.extract_info(url, download=False)
    if info is None:
        return []

    # yt-dlp returns a playlist-like dict for channel URLs
    if "entries" in info:
        return list(info["entries"])
    return [info]


def fetch_subscriptions(channel_urls: list[str]) -> list[dict[str, Any]]:
    """
    Fetch channel info for a list of YouTube channel URLs/IDs.

    Returns a list of dicts with keys:
        id, title, description, thumbnails, subscriber_count
    """
    channels = []
    for url in channel_urls:
        try:
            info = _run_ytdlp(url, extract_flat=False)
            if info:
                ch = info[0]
                channels.append({
                    "youtube_id": ch.get("id", ""),
                    "title": ch.get("channel", ch.get("title", "")),
                    "description": ch.get("description", ""),
                    "thumbnail_url": ch.get("thumbnail", ""),
                    "subscriber_count": ch.get("subscriber", 0),
                })
        except Exception as e:
            print(f"Error fetching channel {url}: {e}")
    return channels


YOUTUBE_THUMB = "https://i.ytimg.com/vi/{vid}/mqdefault.jpg"


def fetch_latest_videos(
    channel_url: str,
    max_results: int = 50,
    since: datetime | None = None,
    detailed: bool = True,
) -> list[dict[str, Any]]:
    """
    Fetch the latest N videos from a channel.

    When `since` is provided, only returns videos published after that time
    (used for incremental refresh).

    When `detailed` is True (default), uses full extraction which returns
    real view_count, timestamp, and thumbnail.

    When `detailed` is False, uses flat mode for speed (no per-video stats).
    Only use for bulk initial imports where speed matters.

    Returns list of dicts with keys:
        id, title, description, thumbnail, timestamp (unix),
        view_count, like_count, duration (seconds), webpage_url
    """
    opts: dict[str, Any] = {
        "playlistend": max_results,
    }
    if not detailed:
        opts["extract_flat"] = "in_playlist"
    if since:
        opts["dateafter"] = since.strftime("%Y%m%d")

    try:
        info = _run_ytdlp(channel_url + "/videos", **opts)
    except Exception as e:
        print(f"Error fetching videos for {channel_url}: {e}")
        return []

    videos = []
    for entry in info:
        if not entry or not entry.get("id"):
            continue

        vid = entry["id"]

        # Extract timestamp: prefer timestamp (unix epoch), fallback upload_date
        pub_ts = entry.get("timestamp")
        if not pub_ts:
            ud = entry.get("upload_date")
            if ud:
                pub_ts = datetime.strptime(ud, "%Y%m%d").replace(tzinfo=timezone.utc).timestamp()

        # Build reliable thumbnail URL
        thumb = entry.get("thumbnail") or YOUTUBE_THUMB.format(vid=vid)

        view_count = entry.get("view_count")
        if view_count is None:
            view_count = 0

        videos.append({
            "youtube_id": vid,
            "title": entry.get("title", ""),
            "description": entry.get("description", ""),
            "thumbnail_url": thumb,
            "published_at": pub_ts,
            "view_count": view_count,
            "like_count": entry.get("like_count", 0),
            "duration_seconds": entry.get("duration", 0),
            "channel_id": entry.get("channel_id", entry.get("uploader_id", "")),
            "channel_title": entry.get("channel", entry.get("uploader", "")),
        })

    return videos


def fetch_video_details(video_ids: list[str]) -> list[dict[str, Any]]:
    """
    Fetch detailed info (view count, duration, etc.) for specific videos.
    Batches multiple videos in a single yt-dlp call.
    """
    if not video_ids:
        return []

    urls = [f"https://www.youtube.com/watch?v={vid}" for vid in video_ids]
    try:
        ydl = yt_dlp.YoutubeDL({
            "quiet": True,
            "extract_flat": False,
            "skip_download": True,
            "ignoreerrors": True,
            "no_warnings": True,
        })
        info = ydl.extract_info(urls[0], download=False)
        results = []
        entries = [info] if isinstance(info, dict) else (info or [])
        for entry in entries:
            if entry and entry.get("id"):
                results.append({
                    "youtube_id": entry["id"],
                    "view_count": entry.get("view_count", 0),
                    "like_count": entry.get("like_count", 0),
                    "duration_seconds": entry.get("duration", 0),
                    "published_at": datetime.fromtimestamp(entry["timestamp"], tz=timezone.utc)
                        if entry.get("timestamp") else None,
                })

        # Process remaining URLs one at a time (yt-dlp API doesn't accept lists)
        for url in urls[1:]:
            try:
                info = ydl.extract_info(url, download=False)
                if info and info.get("id"):
                    results.append({
                        "youtube_id": info["id"],
                        "view_count": info.get("view_count", 0),
                        "like_count": info.get("like_count", 0),
                        "duration_seconds": info.get("duration", 0),
                        "published_at": datetime.fromtimestamp(info["timestamp"], tz=timezone.utc)
                            if info.get("timestamp") else None,
                    })
            except Exception:
                pass
        return results
    except Exception as e:
        print(f"Error fetching video details: {e}")
        return []