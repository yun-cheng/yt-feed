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


# Hot-score "burn-in": hours added to a video's age before dividing views by it.
# Without it, a video published minutes ago divides by ~0.1h and a handful of
# views explodes to the top of the hot order. This shrinks early velocity toward
# 0 until enough time (and thus views) accrues to trust the rate.
HOT_HOUR_OFFSET = 12.0

# like% Bayesian shrinkage: a video's like/view ratio is pulled toward the feed's
# average, weighted by C "pseudo-views". Small-sample videos sit near the prior;
# only videos with >> C views are trusted at their raw ratio.
LIKE_PCT_PSEUDO_VIEWS = 1500
LIKE_PCT_FALLBACK_PRIOR = 0.04  # used when the result set has no views to average


def score_video(view_count: int, published_at: datetime) -> float:
    """Hot score = views / (hours since published + burn-in offset)."""
    now = datetime.now(timezone.utc)
    if published_at.tzinfo is None:
        published_at = published_at.replace(tzinfo=timezone.utc)
    hours = max((now - published_at).total_seconds() / 3600, 0.0)
    return view_count / (hours + HOT_HOUR_OFFSET)


def filter_by_window(videos: list[Video], window: TimeWindow, time_mode: str = "wide") -> list[Video]:
    """Filter videos to the given time window.

    narrow (default): discrete non-overlapping bucket, e.g. 3d = 1d–3d ago
    wide: accumulated from 0, e.g. 3d = 0–3d ago (everything up to the upper bound)
    """
    now = datetime.now(timezone.utc)
    lower_offset, upper_offset = WINDOW_RANGES[window]
    lower = now - upper_offset  # older bound (inclusive)
    upper = now if time_mode == "wide" else now - lower_offset  # newer bound (exclusive)

    result = []
    for v in videos:
        # Exclude member-only videos (0 views but has likes — gated content)
        if v.view_count == 0 and v.like_count > 0:
            continue
        pub = v.published_at
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)
        if lower <= pub < upper:
            result.append(v)
    return result


def rank_videos(videos: list[Video], window: TimeWindow, channel_names: dict[str, str] | None = None, sort: str = "likes", time_mode: str = "wide") -> list[dict]:
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
    filtered = filter_by_window(videos, window, time_mode)
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
            "is_short": bool(v.is_short),
            "score": round(score_video(v.view_count, v.published_at), 2),
        })

    if sort == "views":
        ranked.sort(key=lambda x: x["view_count"], reverse=True)
    elif sort == "likes":
        ranked.sort(key=lambda x: x["like_count"], reverse=True)
    elif sort == "like%":
        # Shrink each ratio toward the feed's average like/view rate so tiny-sample
        # videos can't top the list on a handful of likes (see LIKE_PCT_* above).
        total_likes = sum(x["like_count"] for x in ranked)
        total_views = sum(x["view_count"] for x in ranked)
        prior = total_likes / total_views if total_views else LIKE_PCT_FALLBACK_PRIOR
        c = LIKE_PCT_PSEUDO_VIEWS
        ranked.sort(
            key=lambda x: (x["like_count"] + prior * c) / (x["view_count"] + c),
            reverse=True,
        )
    elif sort == "newest":
        ranked.sort(key=lambda x: x["published_at"], reverse=True)
    elif sort == "oldest":
        ranked.sort(key=lambda x: x["published_at"])
    else:  # score (default)
        ranked.sort(key=lambda x: x["score"], reverse=True)

    return ranked