"""
Auto-categorization engine — uses keyword matching on channel title/description.

Categories and rules are read from / written to config/categories.yaml.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from app.config import settings


DEFAULT_CATEGORIES = {
    "categories": [
        {"name": "科技", "icon": "💻", "sort_order": 0, "keywords": [
            "tech", "code", "programming", "developer", "software", "engineering",
            "AI", "machine learning", "linux", "open source", "startup",
            "科技", "程式", "軟體", "硬體", "電腦", "程式設計", "開發者",
        ]},
        {"name": "音樂", "icon": "🎵", "sort_order": 1, "keywords": [
            "music", "song", "cover", "piano", "guitar", "composer",
            "音樂", "鋼琴", "吉他", "樂團", "歌手", "作曲", "演奏",
        ]},
        {"name": "遊戲", "icon": "🎮", "sort_order": 2, "keywords": [
            "game", "gaming", "playthrough", "lets play", "esports",
            "遊戲", "實況", "電玩", "gaming",
        ]},
        {"name": "知識/教育", "icon": "📚", "sort_order": 3, "keywords": [
            "education", "science", "history", "documentary", "learn", "tutorial",
            "教學", "知識", "科學", "歷史", "紀錄片", "科普", "課程",
        ]},
        {"name": "新聞/時事", "icon": "📰", "sort_order": 4, "keywords": [
            "news", "politics", "current events", "economy", "finance",
            "財經", "新聞", "政治", "時事", "經濟",
        ]},
        {"name": "日常生活", "icon": "☕", "sort_order": 5, "keywords": [
            "vlog", "daily", "lifestyle", "cooking", "travel", "food",
            "日常", "生活", "料理", "旅遊", "美食", "vlog",
        ]},
        {"name": "娛樂", "icon": "🎬", "sort_order": 6, "keywords": [
            "entertainment", "comedy", "funny", "memes", "reaction",
            "搞笑", "娛樂", "綜藝", "迷因",
        ]},
        {"name": "運動/健身", "icon": "💪", "sort_order": 7, "keywords": [
            "fitness", "workout", "gym", "sports", "running", "健身",
            "運動", "訓練", "肌力", "重量訓練",
        ]},
    ],
    "channels": {},
}


def _load_config() -> dict[str, Any]:
    path = Path(settings.categories_path)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            yaml.dump(DEFAULT_CATEGORIES, f, allow_unicode=True, sort_keys=False)
        return DEFAULT_CATEGORIES

    with open(path) as f:
        return yaml.safe_load(f) or DEFAULT_CATEGORIES


def _save_config(config: dict[str, Any]):
    path = Path(settings.categories_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        yaml.dump(config, f, allow_unicode=True, sort_keys=False)


def get_categories() -> list[dict[str, Any]]:
    """Return list of category definitions with their keywords and icons."""
    config = _load_config()
    return config.get("categories", [])


def get_channel_groups() -> dict[str, str]:
    """Return {youtube_id: group_name} mapping."""
    config = _load_config()
    return config.get("channels", {})


def set_channel_group(channel_id: str, group_name: str, auto: bool = False):
    """Assign a channel to a group."""
    config = _load_config()
    if "channels" not in config:
        config["channels"] = {}
    prefix = "auto:" if auto else ""
    config["channels"][channel_id] = f"{prefix}{group_name}"
    _save_config(config)


def auto_categorize(channels: list[dict[str, str]]) -> dict[str, list[str]]:
    """
    Auto-assign each channel to a category based on keyword matching.

    channels: list of {youtube_id, title, description}
    returns: {group_name: [youtube_id, ...]}
    """
    config = _load_config()
    categories = config.get("categories", [])
    existing = config.get("channels", {})

    result: dict[str, list[str]] = {}
    for ch in channels:
        text = f"{ch.get('title', '')} {ch.get('description', '')}".lower()
        best_category = None
        best_score = 0

        for cat in categories:
            score = sum(1 for kw in cat.get("keywords", []) if kw.lower() in text)
            if score > best_score:
                best_score = score
                best_category = cat["name"]

        if best_category and best_score > 0:
            result.setdefault(best_category, []).append(ch["youtube_id"])
            # Only auto-assign if not manually set
            cid = ch["youtube_id"]
            if cid not in existing or existing[cid].startswith("auto:"):
                existing[cid] = f"auto:{best_category}"

    config["channels"] = existing
    _save_config(config)
    return result


def add_category(name: str, icon: str, keywords: list[str]):
    """Add a new category definition."""
    config = _load_config()
    cats = config.get("categories", [])
    if any(c["name"] == name for c in cats):
        return  # already exists
    cats.append({
        "name": name,
        "icon": icon,
        "sort_order": len(cats),
        "keywords": keywords,
    })
    config["categories"] = cats
    _save_config(config)