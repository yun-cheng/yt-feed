"""
YouTube Data API v3 helper — batch video stats lookups.

Uses the work OAuth token (~/.hermes/google_token.json) which has
youtube.readonly scope. This is MUCH faster than yt-dlp full extraction
for getting view counts, timestamps, and durations.

Usage:
    stats = batch_fetch_video_stats(["id1", "id2", ...])
    # Returns {vid: {view_count, like_count, published_at, duration_seconds}}

This module is used by cron_update.py for incremental stats updates.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials

WORK_TOKEN_PATH = os.path.expanduser("~/.hermes/google_token.json")
SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"]
BATCH_SIZE = 50  # max IDs per videos.list request
CACHE_TTL = 3600  # 1 hour cache for recently-fetched video IDs

# Simple in-memory cache: vid → timestamp of last fetch
_fetch_cache: dict[str, float] = {}

# Track quota usage
_quota_used = 0


def _get_creds() -> Credentials:
    with open(WORK_TOKEN_PATH) as f:
        creds = Credentials.from_authorized_user_info(json.load(f), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(GoogleRequest())
    return creds


def _parse_iso8601_duration(duration_str: str) -> int:
    """Convert ISO 8601 duration (PT1H2M3S) to seconds."""
    if not duration_str:
        return 0
    import re
    match = re.match(r"PT?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", duration_str)
    if not match:
        return 0
    h, m, s = [int(g) if g else 0 for g in match.groups()]
    return h * 3600 + m * 60 + s


def batch_fetch_video_stats(video_ids: list[str]) -> dict[str, dict[str, Any]]:
    """
    Fetch stats for a list of video IDs via YouTube Data API videos.list.

    Returns dict: {youtube_id: {view_count, like_count, comment_count,
                   published_at (datetime|None), duration_seconds, thumbnail_url}}
    """
    if not video_ids:
        return {}

    # Deduplicate and filter recently-fetched IDs
    now = time.monotonic()
    unique_ids = list(dict.fromkeys(video_ids))  # dedup, preserve order
    fresh_ids = [
        vid for vid in unique_ids
        if vid not in _fetch_cache or now - _fetch_cache[vid] > CACHE_TTL
    ]

    if not fresh_ids:
        return {}

    results: dict[str, dict[str, Any]] = {}
    creds = _get_creds()
    global _quota_used

    # Process in batches of 50
    batches = [fresh_ids[i:i + BATCH_SIZE] for i in range(0, len(fresh_ids), BATCH_SIZE)]

    with httpx.Client(timeout=30.0) as client:
        for batch in batches:
            ids_param = ",".join(batch)
            resp = client.get(
                "https://www.googleapis.com/youtube/v3/videos",
                headers={"Authorization": f"Bearer {creds.token}"},
                params={
                    "part": "statistics,snippet,contentDetails",
                    "id": ids_param,
                    "hl": "zh",
                },
            )
            _quota_used += 1

            if resp.status_code == 403:
                # Token expired, refresh and retry once
                try:
                    creds.refresh(GoogleRequest())
                    resp = client.get(
                        "https://www.googleapis.com/youtube/v3/videos",
                        headers={"Authorization": f"Bearer {creds.token}"},
                        params={
                            "part": "statistics,snippet,contentDetails",
                            "id": ids_param,
                        },
                    )
                except Exception:
                    continue

            if resp.status_code != 200:
                continue

            data = resp.json()
            for item in data.get("items", []):
                vid = item["id"]
                stats = item.get("statistics", {})
                snippet = item.get("snippet", {})
                content = item.get("contentDetails", {})

                published = snippet.get("publishedAt", "")
                try:
                    pub_dt = datetime.fromisoformat(published.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    pub_dt = None

                results[vid] = {
                    "view_count": int(stats.get("viewCount", 0)),
                    "like_count": int(stats.get("likeCount", 0)),
                    "comment_count": int(stats.get("commentCount", 0)),
                    "published_at": pub_dt,
                    "duration_seconds": _parse_iso8601_duration(content.get("duration", "")),
                    "thumbnail_url": (
                        snippet.get("thumbnails", {})
                        .get("medium", {})
                        .get("url", "")
                    ),
                }

            # Mark all requested IDs as cached (even if not in response — keeps cache fresh)
            for vid in batch:
                _fetch_cache[vid] = now

    return results


def get_quota_used() -> int:
    """Return total YouTube Data API quota units used this session."""
    return _quota_used


def clear_cache():
    """Clear the in-memory fetch cache."""
    _fetch_cache.clear()