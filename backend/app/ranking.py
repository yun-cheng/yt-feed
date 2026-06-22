"""
Ranking engine — score = view_count / hours_since_published.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from enum import Enum

from app.models import Video


class TimeWindow(str, Enum):
    ONE_WEEK = "1w"
    TWO_WEEKS = "2w"
    ONE_MONTH = "1m"
    THREE_MONTHS = "3m"
    SIX_MONTHS = "6m"
    ONE_YEAR = "1y"


WINDOW_DELTA = {
    TimeWindow.ONE_WEEK: timedelta(days=7),
    TimeWindow.TWO_WEEKS: timedelta(days=14),
    TimeWindow.ONE_MONTH: timedelta(days=30),
    TimeWindow.THREE_MONTHS: timedelta(days=90),
    TimeWindow.SIX_MONTHS: timedelta(days=180),
    TimeWindow.ONE_YEAR: timedelta(days=365),
}


def score_video(view_count: int, published_at: datetime) -> float:
    """Score = views / hours since published."""
    now = datetime.now(timezone.utc)
    if published_at.tzinfo is None:
        published_at = published_at.replace(tzinfo=timezone.utc)
    hours = max((now - published_at).total_seconds() / 3600, 0.1)
    return view_count / hours


def filter_by_window(videos: list[Video], window: TimeWindow) -> list[Video]:
    """Filter videos published within the given time window."""
    cutoff = datetime.now(timezone.utc) - WINDOW_DELTA[window]
    result = []
    for v in videos:
        pub = v.published_at
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)
        if pub >= cutoff:
            result.append(v)
    return result


def rank_videos(videos: list[Video], window: TimeWindow, channel_names: dict[str, str] | None = None) -> list[dict]:
    """
    Rank videos by view_count / hours_since_published, filtered by time window.

    Returns list of dicts sorted by score descending, with score included.
    channel_names: optional dict of channel_id → channel_title to include in output.
    """
    filtered = filter_by_window(videos, window)
    ranked = []
    for v in filtered:
        ranked.append({
            "youtube_id": v.youtube_id,
            "title": v.title,
            "channel_id": v.channel_id,
            "channel_name": (channel_names or {}).get(v.channel_id, ""),
            "thumbnail_url": v.thumbnail_url,
            "published_at": v.published_at.isoformat(),
            "view_count": v.view_count,
            "like_count": v.like_count,
            "duration_seconds": v.duration_seconds,
            "score": round(score_video(v.view_count, v.published_at), 2),
        })
    ranked.sort(key=lambda x: x["score"], reverse=True)
    return ranked