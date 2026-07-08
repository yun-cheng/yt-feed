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
from pathlib import Path
from typing import Any

import httpx
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials

from app.config import settings

# Token written by the app's own OAuth flow (/api/auth/login) — this is what the
# in-app "Re-authenticate" link refreshes, so prefer it. Fall back to the external
# "work" token for backwards compatibility.
APP_TOKEN_PATH = str(Path(settings.config_dir) / "youtube_oauth_token.json")
WORK_TOKEN_PATH = os.path.expanduser("~/.hermes/google_token.json")
_TOKEN_PATHS = [APP_TOKEN_PATH, WORK_TOKEN_PATH]
SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"]
BATCH_SIZE = 50  # max IDs per videos.list request
CACHE_TTL = 3600  # 1 hour cache for recently-fetched video IDs

# Simple in-memory cache: vid → timestamp of last fetch
_fetch_cache: dict[str, float] = {}

# Track quota usage
_quota_used = 0


def _save_creds(path: str, creds: Credentials) -> None:
    with open(path, "w") as f:
        json.dump({
            "token": creds.token,
            "refresh_token": creds.refresh_token,
            "token_uri": creds.token_uri,
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "scopes": creds.scopes,
        }, f)


def _get_creds() -> Credentials:
    """Return usable credentials from the first token file that works."""
    last_err: Exception | None = None
    for path in _TOKEN_PATHS:
        try:
            with open(path) as f:
                creds = Credentials.from_authorized_user_info(json.load(f), SCOPES)
        except (FileNotFoundError, ValueError):
            continue
        try:
            if creds.expired and creds.refresh_token:
                creds.refresh(GoogleRequest())
                _save_creds(path, creds)  # persist the refreshed access token
            return creds
        except Exception as e:  # revoked/expired refresh token — try the next file
            last_err = e
    raise last_err or FileNotFoundError("no usable YouTube token found")


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
    try:
        creds = _get_creds()
    except Exception as e:
        # Token missing/expired/revoked — don't crash the caller; let it fall back
        # (e.g. cron_update uses yt-dlp for stats when the Data API is unavailable).
        print(f"[youtube_api] credentials unavailable, skipping API stats: {e}")
        return {}
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
                    "hl": "zh-TW",
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

                # Prefer localized title (respects hl= param), fall back to default
                localized_title = (
                    snippet.get("localized", {}).get("title")
                    or snippet.get("title", "")
                )
                results[vid] = {
                    "title": localized_title,
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


# --- Credentials health (surfaced in the UI so the token gets re-authed) ---
_cred_check: tuple[float, dict[str, Any]] | None = None
_CRED_CHECK_TTL = 300  # re-check at most every 5 min (so a re-auth clears it quickly)


def youtube_credentials_status(force: bool = False) -> dict[str, Any]:
    """Report whether the YouTube Data API token is usable.

    {"ok": True}  — token loads/refreshes fine.
    {"ok": False, "reason": "..."} — expired/revoked/missing; stats won't update.
    Cached briefly so calling it repeatedly doesn't spam token refreshes.
    """
    global _cred_check
    now = time.monotonic()
    if not force and _cred_check and now - _cred_check[0] < _CRED_CHECK_TTL:
        return _cred_check[1]
    try:
        _get_creds()
        status: dict[str, Any] = {"ok": True, "reason": ""}
    except Exception as e:
        status = {"ok": False, "reason": str(e)[:200]}
    _cred_check = (now, status)
    return status