"""
Tag router — channels can have multiple tags. Tags are used for filtering in the sidebar.
"""

from __future__ import annotations

import yaml
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import Channel, Tag, ChannelTag, Video
from app.config import settings

router = APIRouter(prefix="/tags")


async def get_db():
    async with async_session() as session:
        yield session


# ── Default tags with keyword rules ──────────────────────────────────

DEFAULT_TAGS = {
    # ── Coding / Tech ──
    "coding": {"group": "開發", "icon": "💻", "keywords": [
        "code", "programming", "developer", "software", "engineering",
        "coding", "程式", "程式設計", "開發者", "coding", "web dev",
        "app dev", "mobile dev", "system design", "cs dojo",
        "developedbyed", "epcdiy", "fireship", "coding tech",
        "academind", "philipp lackner", "very good ventures",
        "theo", "t3.gg", "convex", "web dev simplified",
        "the coding sloth", "cloud tech",
    ]},
    "flutter": {"group": "開發", "icon": "🐦", "keywords": [
        "flutter", "dart", "resocoder", "filledstacks",
        "flutter community", "flutter explained",
    ]},
    "AI": {"group": "開發", "icon": "🤖", "keywords": [
        "ai", "machine learning", "deepmind", "anthropic",
        "claude", "artificial intelligence", "deep learning",
    ]},
    "backend": {"group": "開發", "icon": "⚙️", "keywords": [
        "backend", "server", "api", "database", "firebase",
        "google cloud", "cloud", "雲端", "serverless",
        "infrastructure", "devops", "linux",
    ]},
    "frontend": {"group": "開發", "icon": "🎨", "keywords": [
        "frontend", "ui", "ux", "css", "html", "javascript",
        "react", "vue", "angular", "web", "網頁",
    ]},
    "google": {"group": "開發", "icon": "🔵", "keywords": [
        "google", "firebase", "google cloud", "google for developers",
        "google deepmind", "gdg", "line developers",
    ]},
    "tech-review": {"group": "開發", "icon": "📱", "keywords": [
        "review", "評測", "開箱", "tech review", "terry chen",
        "泰瑞", "先看评测", "作业本", "爱否", "极创意",
        "mediastorm", "影视飓风", "曲博",
    ]},
    "diy": {"group": "開發", "icon": "🔧", "keywords": [
        "diy", "水電", "宅水電", "超認真少年", "超認真",
        "arduino", "maker", "自造",
    ]},

    # ── Language ──
    "chinese": {"group": "語言", "icon": "🀄", "keywords": [
        "中文", "chinese", "普通話", "mandarin",
    ]},
    "english": {"group": "語言", "icon": "🇬🇧", "keywords": [
        "english", "英文", "英語", "st english", "esl",
    ]},
    "japanese": {"group": "語言", "icon": "🇯🇵", "keywords": [
        "japanese", "日文", "日語", "日本語", "秋山耀平",
        "秋山燿平", "出口日語", "日本", "東京",
    ]},

    # ── Music ──
    "piano": {"group": "音樂", "icon": "🎹", "keywords": [
        "piano", "鋼琴", "marasy", "pianist", "ピアノ",
        "めいぷる", "maple piano", "演奏",
    ]},
    "music": {"group": "音樂", "icon": "🎵", "keywords": [
        "music", "song", "cover", "guitar", "composer",
        "音樂", "吉他", "樂團", "歌手", "作曲",
        "nicechord", "好和弦", "musecow", "音樂家",
    ]},

    # ── Finance / News ──
    "finance": {"group": "財經", "icon": "📈", "keywords": [
        "finance", "invest", "stock", "股票", "投資", "理財",
        "財經", "經濟", "caven", "成長家", "卡爾先生",
        "小新新講", "艾爾文", "錢進前十趴", "這leo人",
        "美股", "nick 美股", "春哥", "acquired", "startup",
        "商業", "創業", "allen lab", "bill gates",
    ]},
    "news": {"group": "財經", "icon": "📰", "keywords": [
        "news", "politics", "時事", "新聞", "政治",
        "公視", "新聞實驗室", "dcard報報", "cheap",
        "黃國昌", "曾博恩", "博恩",
    ]},

    # ── 知識 ──
    "science": {"group": "知識", "icon": "🔬", "keywords": [
        "science", "scientific", "physics", "biology", "chemistry",
        "科學", "科普", "nature video", "scishow",
        "pansi", "泛科學", "kurzgesagt", "nutshell",
        "crashcourse", "big think", "mark rober",
        "reallifelore", "geography now",
    ]},
    "education": {"group": "知識", "icon": "📚", "keywords": [
        "education", "learn", "tutorial", "教學", "課程",
        "知識", "history", "歷史", "回形针", "paperclip",
        "下一本", "讀什麼", "阅部客", "閱讀", "罗振宇",
        "罗辑思维", "邏輯思維", "老師好", "何同学",
    ]},
    "documentary": {"group": "知識", "icon": "🎥", "keywords": [
        "documentary", "紀錄片", "discovery", "國家地理",
        "national geographic", "nature video",
    ]},
    "art": {"group": "知識", "icon": "🎨", "keywords": [
        "art", "drawing", "painting", "illustration", "procreate",
        "proko", "素描", "水彩", "油畫", "插畫",
        "有點艺思", "刘采翎", "創意",
    ]},
    "health": {"group": "知識", "icon": "🏥", "keywords": [
        "health", "medical", "medicine", "健康", "醫療",
        "醫學", "醫生", "蒼藍鴿", "滄瀾教主", "漢醫",
        "中醫", "當代漢醫苑", "保健", "養生",
    ]},

    # ── 生活 ──
    "lifestyle": {"group": "生活", "icon": "☕", "keywords": [
        "lifestyle", "vlog", "日常", "生活", "ace moment",
        "gq taiwan", "穿搭", "時尚", "居家", "lo-fi house",
        "living big", "tiny house", "erik van conover",
        "我是老爸", "跳脫", "嘟式圈",
    ]},
    "travel": {"group": "生活", "icon": "✈️", "keywords": [
        "travel", "旅遊", "旅行", "lonely planet", "景點",
        "背包客", "出國", "the dodo men", "嘟嘟人",
        "paolo fromtokyo", "台客不在家", "台客劇場",
        "一条", "張修修", "真奈特", "茶里",
    ]},
    "real-estate": {"group": "生活", "icon": "🏠", "keywords": [
        "real estate", "房地產", "買房", "賞屋", "房屋",
        "不動產", "移民", "東京購屋", "看房", "租寓",
        "南投買好房", "美國房地產",
    ]},
    "fitness": {"group": "生活", "icon": "💪", "keywords": [
        "fitness", "workout", "gym", "健身", "運動", "訓練",
        "肌肉", "增重", "卓叔", "減脂", "拳擊",
        "hu boxing", "古月拳館", "拳擊小潘", "james tripp",
    ]},

    # ── 娛樂 ──
    "entertainment": {"group": "娛樂", "icon": "🎬", "keywords": [
        "entertainment", "comedy", "funny", "搞笑", "娛樂",
        "綜藝", "迷因", "onion man", "洋蔥", "反正我很閒",
        "啾啾鞋", "steven he", "zack d films", "蔡阿嘎",
        "jordan has no life", "j-bao", "賤葆", "dcard video",
    ]},
    "gaming": {"group": "娛樂", "icon": "🎮", "keywords": [
        "game", "gaming", "遊戲", "電玩", "實況",
        "最強聯盟", "teogaming",
    ]},
    "podcast": {"group": "娛樂", "icon": "🎙️", "keywords": [
        "podcast", "pod cast", "廣播", "音頻", "音頻節目",
        "博音", "滄瀾教主", "知識長", "國威", "錢進前十趴",
        "pocast", "audio", "電台", "訪談節目",
    ]},
}

TAGS_PATH = str(settings.project_root) + "/backend/config/tags.yaml"


def _load_tags_config() -> dict:
    import os
    if os.path.exists(TAGS_PATH):
        with open(TAGS_PATH) as f:
            return yaml.safe_load(f) or {"tags": {}}
    return {"tags": DEFAULT_TAGS}


def _save_tags_config(config: dict):
    with open(TAGS_PATH, "w") as f:
        yaml.dump(config, f, allow_unicode=True, sort_keys=False)


# ── API endpoints ─────────────────────────────────────────────

@router.get("")
async def list_tags(db: AsyncSession = Depends(get_db)):
    """List all tags with channel counts."""
    config = _load_tags_config()
    tags_config = config.get("tags", {})

    # Get tag counts from DB
    result = await db.execute(
        select(ChannelTag.tag_name, func.count(ChannelTag.channel_id))
        .group_by(ChannelTag.tag_name)
    )
    counts = dict(result.all())

    return [
        {
            "name": name,
            "group": data.get("group", "其他"),
            "icon": data.get("icon", "🏷️"),
            "channel_count": counts.get(name, 0),
        }
        for name, data in tags_config.items()
    ]


@router.get("/channels")
async def list_tagged_channels(db: AsyncSession = Depends(get_db)):
    """Return all channel→tags mapping."""
    result = await db.execute(select(ChannelTag))
    tags_map: dict[str, list[str]] = {}
    for ct in result.scalars().all():
        tags_map.setdefault(ct.channel_id, []).append(ct.tag_name)
    return tags_map


@router.post("/auto-assign")
async def auto_assign_tags(db: AsyncSession = Depends(get_db)):
    """Auto-tag all channels based on name/description keyword matching."""
    config = _load_tags_config()
    tags_config = config.get("tags", {})

    result = await db.execute(select(Channel))
    channels = result.scalars().all()

    # Clear existing auto-assigned tags
    from sqlalchemy import delete as sa_delete
    await db.execute(sa_delete(ChannelTag).where(ChannelTag.auto_assigned == 1))

    assigned = 0
    for ch in channels:
        title = ch.title or ""
        desc = ch.description or ""
        text = f"{title} {desc}".lower()

        # Smart language detection
        import re
        has_cjk = bool(re.search(r'[\u4e00-\u9fff\u3400-\u4dbf]', title))
        has_hiragana = bool(re.search(r'[\u3040-\u309f]', title))
        has_katakana = bool(re.search(r'[\u30a0-\u30ff]', title))
        is_ascii = all(ord(c) < 128 for c in title if not c.isspace())

        if has_cjk:
            db.add(ChannelTag(channel_id=ch.youtube_id, tag_name="chinese", auto_assigned=1))
            assigned += 1
        elif has_hiragana or has_katakana:
            db.add(ChannelTag(channel_id=ch.youtube_id, tag_name="japanese", auto_assigned=1))
            assigned += 1
        elif is_ascii and len(title) > 3:
            db.add(ChannelTag(channel_id=ch.youtube_id, tag_name="english", auto_assigned=1))
            assigned += 1

        # Keyword-based tag matching
        for tag_name, tag_data in tags_config.items():
            # Skip language tags (already handled above)
            if tag_name in ("chinese", "english", "japanese"):
                continue
            keywords = tag_data.get("keywords", [])
            if any(kw.lower() in text for kw in keywords):
                db.add(ChannelTag(
                    channel_id=ch.youtube_id,
                    tag_name=tag_name,
                    auto_assigned=1,
                ))
                assigned += 1

    await db.commit()

    # Save default tags config
    _save_tags_config(config)

    return {"assigned": assigned, "channels": len(channels)}


@router.post("/{channel_id}")
async def set_channel_tags(
    channel_id: str,
    tag_names: list[str],
    db: AsyncSession = Depends(get_db),
):
    """Manually set tags for a channel (replaces all)."""
    # Verify channel exists
    result = await db.execute(
        select(Channel).where(Channel.youtube_id == channel_id)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(404, "Channel not found")

    # Remove existing manual tags for this channel
    from sqlalchemy import delete as sa_delete
    await db.execute(
        sa_delete(ChannelTag).where(
            ChannelTag.channel_id == channel_id,
            ChannelTag.auto_assigned == 0,
        )
    )

    # Add new tags
    for tag in tag_names:
        db.add(ChannelTag(
            channel_id=channel_id,
            tag_name=tag,
            auto_assigned=0,
        ))

    await db.commit()
    return {"status": "ok", "channel_id": channel_id, "tags": tag_names}


@router.get("/feed")
async def feed_by_tags(
    tags: str = "",
    window: str = "1w",
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    """Get ranked videos filtered by tags (AND logic, comma-separated)."""
    from app.ranking import TimeWindow, rank_videos

    tag_list = [t.strip() for t in tags.split(",") if t.strip()]

    # Find channels matching all selected tags
    if tag_list:
        # Channels that have ALL selected tags
        stmt = select(ChannelTag.channel_id).where(
            ChannelTag.tag_name.in_(tag_list)
        ).group_by(ChannelTag.channel_id).having(
            func.count(ChannelTag.tag_name) == len(tag_list)
        )
        result = await db.execute(stmt)
        channel_ids = {r[0] for r in result}
    else:
        result = await db.execute(select(Channel.youtube_id))
        channel_ids = {r[0] for r in result}

    # Query videos for these channels
    stmt = select(Video).where(Video.channel_id.in_(channel_ids)).order_by(
        Video.published_at.desc()
    ).limit(2000)
    result = await db.execute(stmt)
    all_videos = result.scalars().all()

    # Include channel names
    chan_result = await db.execute(select(Channel.youtube_id, Channel.title))
    chan_titles = {r.youtube_id: r.title for r in chan_result}

    ranked = rank_videos(list(all_videos), TimeWindow(window), chan_titles)
    return {
        "window": window,
        "tags": tag_list,
        "videos": ranked[:limit],
        "total": len(ranked),
    }