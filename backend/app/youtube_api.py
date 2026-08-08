"""
YouTube Data API v3 helper — batch video stats lookups.

Uses the app's OAuth token (config/youtube_oauth_token.json, youtube.readonly
scope) written by the in-app login flow. This is MUCH faster than yt-dlp full
extraction for getting view counts, timestamps, and durations.

Usage:
    stats = batch_fetch_video_stats(["id1", "id2", ...])
    # Returns {vid: {view_count, like_count, published_at, duration_seconds}}

This module is used by cron_update.py for incremental stats updates.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials

from app.config import settings

# Token written by the app's own OAuth flow (/api/auth/login) — this is what the
# in-app "Re-authenticate" link refreshes.
APP_TOKEN_PATH = str(Path(settings.config_dir) / "youtube_oauth_token.json")
_TOKEN_PATHS = [APP_TOKEN_PATH]
SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"]
BATCH_SIZE = 50  # max IDs per videos.list request
CACHE_TTL = 3600  # 1 hour cache for recently-fetched video IDs

# Simple in-memory cache: vid → timestamp of last fetch
_fetch_cache: dict[str, float] = {}

# The uploads playlist stops handing out pages here, whatever the channel's true
# videoCount says (a 40,097-video channel reports 20,000 as its totalResults).
# 400 pages × 50 = exactly that ceiling, so the pager's own bound IS YouTube's.
ARCHIVE_CEILING = 20_000

# Track quota usage. In-memory and therefore per-process — it's what the run
# summaries print. `take_quota_delta()` hands the spend since the last call to
# app.quota, which is where a budget that survives a restart lives.
_quota_used = 0
_quota_flushed = 0


class QuotaExceeded(RuntimeError):
    """The Data API refused because the day's allowance is gone.

    Distinct from an auth failure, which arrives with the same 403 and which we
    answer by refreshing the token and retrying. Retrying a quota refusal just
    burns requests against an API that will keep saying no until midnight
    Pacific, so callers stop for the day instead.
    """


# Error reasons that mean "you have spent your allowance", as opposed to the
# authError/forbidden reasons that mean "your token is stale".
_QUOTA_REASONS = {"quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded",
                  "userRateLimitExceeded"}


def _quota_refusal(resp: httpx.Response) -> bool:
    """Is this 403 about the allowance rather than the credentials?"""
    try:
        errors = resp.json().get("error", {}).get("errors", [])
    except (ValueError, AttributeError):
        return False
    return any(e.get("reason") in _QUOTA_REASONS for e in errors)


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
                if _quota_refusal(resp):
                    # Out of allowance, not out of token. Every remaining batch
                    # would be refused the same way, so stop rather than spend
                    # the rest of the run being told no.
                    raise QuotaExceeded("video stats lookup hit the daily allowance")
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


def take_quota_delta() -> int:
    """Units spent since the last call, and reset. Feeds the persisted ledger."""
    global _quota_used, _quota_flushed
    delta = _quota_used - _quota_flushed
    _quota_flushed = _quota_used
    return max(0, delta)


def fetch_uploads_page(
    channel_id: str,
    page_token: str | None = None,
    pages: int = 1,
) -> dict[str, Any]:
    """Walk `pages` pages of a channel's uploads playlist, newest-first.

    Returns {"items": [{"youtube_id", "published_at"}], "cursor": str|None,
    "exhausted": bool}. `cursor` is where to resume — it is self-contained, so
    persisting it and coming back in another process days later picks up exactly
    where this left off, which is what makes a budgeted fill possible at all.
    `exhausted` means the playlist ran out: this channel has no more to give.

    Costs 1 quota unit per page (50 videos). Raises QuotaExceeded when the day's
    allowance is gone, so a caller can stop rather than hammer.
    """
    # A channel's uploads live in a playlist whose id is the channel id with the
    # "UC" prefix swapped for "UU".
    uploads_id = "UU" + channel_id[2:]
    try:
        creds = _get_creds()
    except Exception as e:
        print(f"[youtube_api] credentials unavailable, skipping uploads fetch: {e}")
        return {"items": [], "cursor": page_token, "exhausted": False}
    global _quota_used

    out: list[dict[str, Any]] = []
    cursor = page_token
    exhausted = False
    refreshed = False
    with httpx.Client(timeout=30.0) as client:
        walked = 0
        while walked < pages:
            params = {
                "part": "contentDetails",
                "playlistId": uploads_id,
                "maxResults": 50,
            }
            if cursor:
                params["pageToken"] = cursor
            try:
                resp = client.get(
                    "https://www.googleapis.com/youtube/v3/playlistItems",
                    headers={"Authorization": f"Bearer {creds.token}"},
                    params=params,
                )
            except httpx.HTTPError as e:
                # A flaky page shouldn't sink the whole walk — stop and keep the
                # cursor. The caller's insert is idempotent and the next run
                # resumes from exactly here.
                print(f"[youtube_api] uploads page failed ({e!r}); returning {len(out)} so far")
                break
            _quota_used += 1
            walked += 1

            if resp.status_code == 403:
                if _quota_refusal(resp):
                    raise QuotaExceeded(f"uploads walk for {channel_id} hit the daily allowance")
                # A stale token — refresh once and retry this page. Once, not
                # forever: a refresh that doesn't fix it never will.
                if refreshed:
                    break
                refreshed = True
                try:
                    creds.refresh(GoogleRequest())
                    walked -= 1  # the retry shouldn't count against the page budget
                    continue
                except Exception:
                    break
            if resp.status_code != 200:
                break  # 404 = no uploads playlist; anything else = give up

            data = resp.json()
            for item in data.get("items", []):
                cd = item.get("contentDetails", {})
                vid = cd.get("videoId")
                raw = cd.get("videoPublishedAt", "")
                if not vid:
                    continue
                try:
                    pub = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    # Private/deleted items lack a publish date — skip them.
                    continue
                out.append({"youtube_id": vid, "published_at": pub})

            cursor = data.get("nextPageToken")
            if not cursor:
                exhausted = True
                break

    return {"items": out, "cursor": cursor, "exhausted": exhausted}


def fetch_channel_video_counts(channel_ids: list[str]) -> dict[str, int]:
    """Lifetime upload count per channel — 50 channels for one quota unit.

    This is the channel's TRUE count, which for very large channels exceeds what
    the uploads playlist will actually page through (ARCHIVE_CEILING).
    """
    if not channel_ids:
        return {}
    try:
        creds = _get_creds()
    except Exception as e:
        print(f"[youtube_api] credentials unavailable, skipping video counts: {e}")
        return {}
    global _quota_used

    counts: dict[str, int] = {}
    with httpx.Client(timeout=30.0) as client:
        for i in range(0, len(channel_ids), BATCH_SIZE):
            chunk = channel_ids[i:i + BATCH_SIZE]
            resp = client.get(
                "https://www.googleapis.com/youtube/v3/channels",
                headers={"Authorization": f"Bearer {creds.token}"},
                params={"part": "statistics", "id": ",".join(chunk)},
            )
            _quota_used += 1
            if resp.status_code == 403 and _quota_refusal(resp):
                raise QuotaExceeded("channel video-count lookup hit the daily allowance")
            if resp.status_code != 200:
                break
            for item in resp.json().get("items", []):
                try:
                    counts[item["id"]] = int(item["statistics"]["videoCount"])
                except (KeyError, TypeError, ValueError):
                    continue
    return counts


def fetch_channel_avatars(channel_ids: list[str]) -> dict[str, str]:
    """Channel avatar URLs — 50 channels for one quota unit.

    A video extraction carries no avatar at all: yt-dlp's `thumbnails` on a video
    are that video's frames, so the uploader's picture has to come from
    somewhere else. This is the cheap somewhere.
    """
    if not channel_ids:
        return {}
    try:
        creds = _get_creds()
    except Exception as e:
        print(f"[youtube_api] credentials unavailable, skipping avatars: {e}")
        return {}
    global _quota_used

    avatars: dict[str, str] = {}
    with httpx.Client(timeout=30.0) as client:
        for i in range(0, len(channel_ids), BATCH_SIZE):
            chunk = channel_ids[i:i + BATCH_SIZE]
            resp = client.get(
                "https://www.googleapis.com/youtube/v3/channels",
                headers={"Authorization": f"Bearer {creds.token}"},
                params={"part": "snippet", "id": ",".join(chunk)},
            )
            _quota_used += 1
            if resp.status_code == 403 and _quota_refusal(resp):
                raise QuotaExceeded("channel avatar lookup hit the daily allowance")
            if resp.status_code != 200:
                break
            for item in resp.json().get("items", []):
                thumbs = (item.get("snippet") or {}).get("thumbnails") or {}
                # Smallest first, which is 88px — the size every subscribed
                # channel's avatar already uses (`=s88` on all 145 of them), and
                # the size these are actually drawn at. "high" is 800px, an
                # eight-hundred-pixel image for a forty-pixel circle.
                for size in ("default", "medium", "high"):
                    url = (thumbs.get(size) or {}).get("url")
                    if url:
                        avatars[item["id"]] = url
                        break
    return avatars


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