"""
Ranking engine — score = view_count / hours_since_published.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from enum import Enum

from app.models import Video


class TimeWindow(str, Enum):
    ONE_DAY = "1d"
    THREE_DAYS = "3d"
    ONE_WEEK = "1w"
    TWO_WEEKS = "2w"
    ONE_MONTH = "1m"
    THREE_MONTHS = "3m"
    SIX_MONTHS = "6m"
    ONE_YEAR = "1y"


# Each window is a discrete bucket: (lower_bound, upper_bound) in timedeltas from now.
# 1d  = past 24h
# 3d  = 1–3 days ago
# 1w  = 3–7 days ago
# 2w  = 7–14 days ago
# 1m  = 14–30 days ago
# 3m  = 30–90 days ago
# 6m  = 90–180 days ago
# 1y  = 180–365 days ago
WINDOW_RANGES = {
    TimeWindow.ONE_DAY:        (timedelta(days=0),   timedelta(days=1)),
    TimeWindow.THREE_DAYS:     (timedelta(days=1),   timedelta(days=3)),
    TimeWindow.ONE_WEEK:       (timedelta(days=3),   timedelta(days=7)),
    TimeWindow.TWO_WEEKS:      (timedelta(days=7),   timedelta(days=14)),
    TimeWindow.ONE_MONTH:      (timedelta(days=14),  timedelta(days=30)),
    TimeWindow.THREE_MONTHS:   (timedelta(days=30),  timedelta(days=90)),
    TimeWindow.SIX_MONTHS:     (timedelta(days=90),  timedelta(days=180)),
    TimeWindow.ONE_YEAR:       (timedelta(days=180), timedelta(days=365)),
}


def score_video(view_count: int, published_at: datetime) -> float:
    """Score = views / hours since published."""
    now = datetime.now(timezone.utc)
    if published_at.tzinfo is None:
        published_at = published_at.replace(tzinfo=timezone.utc)
    hours = max((now - published_at).total_seconds() / 3600, 0.1)
    return view_count / hours


def filter_by_window(videos: list[Video], window: TimeWindow) -> list[Video]:
    """Filter videos to the discrete time bucket for the given window.

    Each window is a non-overlapping slice, e.g.:
       3d = now–3d ago  (past 72h)
       1w = 3d–7d ago   (rest of the week)
       2w = 7d–14d ago  (last week)
       …
    """
    now = datetime.now(timezone.utc)
    lower_offset, upper_offset = WINDOW_RANGES[window]
    lower = now - upper_offset  # older bound (inclusive)
    upper = now - lower_offset  # newer bound (exclusive)

    result = []
    for v in videos:
        pub = v.published_at
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)
        if lower <= pub < upper:
            result.append(v)
    return result


def rank_videos(videos: list[Video], window: TimeWindow, channel_names: dict[str, str] | None = None, sort: str = "score") -> list[dict]:
    """
    Rank videos filtered by time window, sorted by the given criteria.

    Sort modes:
      score   — view_count / hours_since_published (default)
      views   — view_count descending
      likes   — like_count descending
      like%   — like_count / view_count (engagement rate)
      newest  — published_at descending
      oldest  — published_at ascending

    Returns list of dicts with score included.
    channel_names: optional dict of channel_id → channel_title.
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

    if sort == "views":
        ranked.sort(key=lambda x: x["view_count"], reverse=True)
    elif sort == "likes":
        ranked.sort(key=lambda x: x["like_count"], reverse=True)
    elif sort == "like_pct" or sort == "like%":
        ranked.sort(key=lambda x: x["like_count"] / max(x["view_count"], 100) * 100, reverse=True)
    elif sort == "newest":
        ranked.sort(key=lambda x: x["published_at"], reverse=True)
    elif sort == "oldest":
        ranked.sort(key=lambda x: x["published_at"])
    else:  # score (default)
        ranked.sort(key=lambda x: x["score"], reverse=True)

    return ranked