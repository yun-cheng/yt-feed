"""
Tag router — channels can have multiple tags. Tags are used for filtering in the sidebar.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import (
    Channel, ChannelTag, ChannelTagRejection, Video, HiddenChannel,
)

router = APIRouter(prefix="/tags")


async def get_db():
    async with async_session() as session:
        yield session


# ── Taxonomy ─────────────────────────────────────────────────────────
#
# A curated seed: fixed GROUPS (the sidebar's navigation frame), each with
# `main` labels (broad, auto-applied) and `sub` labels (specific, offered as
# suggestions). An LLM (app.llm) classifies each channel into this vocabulary;
# it may invent new *sub* labels when a specific topic isn't covered, but never
# new main labels or groups. See llm_label_channel().
TAXONOMY_VERSION = 10

SEED_TAXONOMY: dict[str, dict] = {
    "Language": {
        "icon": "🌐",
        "main": {"chinese": "🀄", "english": "🇬🇧", "japanese": "🇯🇵",
                 "korean": "🇰🇷", "spanish": "🇪🇸", "indonesian": "🇮🇩"},
        "sub": [],
    },
    "Entertainment": {
        "icon": "🎬",
        "main": {"entertainment": "🎬", "comedy": "😂", "film-tv": "🍿",
                 "anime": "🌸", "podcast": "🎙️", "vlog": "📹",
                 "variety": "🎪", "documentary": "🎥"},
        "sub": ["reaction", "skits", "talk-show", "storytelling", "vtuber",
                "drama", "celebrity", "behind-the-scenes"],
    },
    "Music": {
        "icon": "🎵",
        "main": {"music": "🎵"},
        "sub": ["pop", "rock", "classical", "hip-hop", "jazz", "electronic",
                "k-pop", "j-pop", "piano", "guitar", "covers", "vocaloid",
                "music-theory"],
    },
    "Gaming": {
        "icon": "🎮",
        "main": {"gaming": "🎮", "esports": "🏆"},
        "sub": ["rpg", "fps", "strategy", "simulation", "mmo",
                "league-of-legends", "speedrun", "game-dev", "retro-games"],
    },
    "Sports": {
        "icon": "🏅",
        "main": {"sports": "🏅"},
        "sub": ["football", "basketball", "baseball", "boxing", "mma",
                "motorsport", "tennis", "golf", "combat-sports"],
    },
    "Lifestyle": {
        "icon": "☕",
        "main": {"food": "🍜", "travel": "✈️", "fitness": "💪", "fashion": "👗",
                 "beauty": "💄", "home": "🏠", "health": "🏥", "diy": "🔧",
                 "pets": "🐾", "art": "🎨", "autos": "🚗", "productivity": "⚡"},
        "sub": ["cooking", "recipes", "tourism", "backpacking", "bodybuilding",
                "nutrition", "weight-loss", "makeup", "skincare",
                "interior-design", "home-renovation", "minimalism", "drawing",
                "illustration", "design", "parenting", "relationships"],
    },
    "Tech": {
        "icon": "💻",
        "main": {"tech": "📱", "coding": "💻", "ai": "🤖"},
        "sub": ["gadgets", "reviews", "unboxing", "web-dev", "mobile-dev",
                "data-science", "devops", "cybersecurity", "cloud", "python",
                "hardware", "tech-news"],
    },
    "Knowledge": {
        "icon": "📚",
        "main": {"science": "🔬", "education": "📚", "history": "📜",
                 "books": "📖", "language-learning": "🗣️"},
        "sub": ["physics", "biology", "chemistry", "space", "psychology",
                "philosophy", "geography", "nature", "wildlife", "engineering",
                "explainer"],
    },
    "Society": {
        "icon": "🏛️",
        "main": {"news": "📰", "politics": "🏛️", "finance": "📈",
                 "business": "💼", "real-estate": "🏘️", "career": "🧑‍💼"},
        "sub": ["investing", "stocks", "crypto", "economics", "entrepreneurship",
                "culture", "law", "geopolitics", "commentary", "retirement"],
    },
}


def _derive_maps():
    group_of, icon_of, kind_of = {}, {}, {}
    for grp, d in SEED_TAXONOMY.items():
        for lbl, ic in d["main"].items():
            group_of[lbl] = grp
            icon_of[lbl] = ic
            kind_of[lbl] = "language" if grp == "Language" else "main"
        for lbl in d["sub"]:
            group_of[lbl] = grp
            icon_of[lbl] = d["icon"]  # subs inherit the group icon until promoted
            kind_of[lbl] = "sub"
    return group_of, icon_of, kind_of


TAG_GROUP, TAG_ICON, TAG_KIND = _derive_maps()
# Labels the LLM is allowed to APPLY (everything else it returns becomes a
# suggestion): the main labels plus the language labels.
MAIN_LABELS = {l for l, k in TAG_KIND.items() if k in ("main", "language")}
LANGUAGE_LABELS = {l for l, k in TAG_KIND.items() if k == "language"}


def tag_meta(name: str) -> tuple[str, str, str]:
    """(group, icon, kind) for a label, defaulting to Other for invented ones."""
    return (
        TAG_GROUP.get(name, "Other"),
        TAG_ICON.get(name, "🏷️"),
        TAG_KIND.get(name, "sub"),
    )


def _vocab_text() -> str:
    lines = []
    for grp, d in SEED_TAXONOMY.items():
        line = f"{grp} — main: {', '.join(d['main'])}"
        if d["sub"]:
            line += f"; sub: {', '.join(d['sub'])}"
        lines.append(line)
    return "\n".join(lines)


def _label_system_prompt() -> str:
    return (
        "We want to give these YouTube channels labels describing what each "
        "channel is about.\n\n"
        "You get a channel's name, its self-written description, and any YouTube "
        "topic hints. Use those together with what you already know about the "
        "channel to choose labels from the vocabulary below.\n\n"
        "- \"main\": the broad categories the channel is substantially about — "
        "choose from the MAIN labels only. Include the channel's main "
        "language(s) here too (one or more).\n"
        "- \"suggested\": more specific sub-genres or minor recurring themes — "
        "choose from the SUB labels. If a clear, specific topic has no matching "
        "sub label, you may add a new one (single word or hyphenated, "
        "lowercase). Never invent new main labels or new groups.\n"
        "- Judge by what the channel is actually about, not incidental bio "
        "mentions — ignore past jobs, one-off anecdotes, certifications, and "
        "links to other platforms. \"I used to work at Intel\" isn't tech.\n"
        "- Prefer precision. Most channels have 1–3 main labels besides the "
        "language. If nothing fits, return empty lists.\n\n"
        "Vocabulary:\n" + _vocab_text() + "\n\n"
        'Return JSON: {"main": ["..."], "suggested": ["..."]}'
    )



# ── API endpoints ─────────────────────────────────────────────

@router.get("")
async def list_tags(
    include_empty: bool = Query(
        default=False, description="include tags no channel has (for the tag picker)"
    ),
    db: AsyncSession = Depends(get_db),
):
    """List tags with channel counts.

    Defaults to only tags in use — the taxonomy is universal (every music genre,
    every sport), so the sidebar shows just the user's slice of it. The tag
    picker passes include_empty=true, since you must be able to add a label
    nobody has yet.
    """
    result = await db.execute(
        select(ChannelTag.tag_name, func.count(ChannelTag.channel_id))
        .group_by(ChannelTag.tag_name)
    )
    counts = dict(result.all())

    # Names to consider: everything in use, plus (for the picker) the whole seed.
    names = set(counts)
    if include_empty:
        names |= set(TAG_GROUP)

    out = []
    for name in names:
        c = counts.get(name, 0)
        if not include_empty and not c:
            continue
        group, icon, kind = tag_meta(name)
        out.append({"name": name, "group": group, "icon": icon,
                    "kind": kind, "channel_count": c})
    return out


@router.get("/channels")
async def list_tagged_channels(db: AsyncSession = Depends(get_db)):
    """Return all channel→tags mapping."""
    result = await db.execute(select(ChannelTag))
    tags_map: dict[str, list[str]] = {}
    for ct in result.scalars().all():
        tags_map.setdefault(ct.channel_id, []).append(ct.tag_name)
    return tags_map


def _channel_topics(channel) -> list[str]:
    """The channel's stored YouTube topicCategories (empty if never fetched)."""
    import json

    try:
        return json.loads(channel.topics) if channel.topics else []
    except (ValueError, TypeError):
        return []


# How many recent video titles to sample when detecting a channel's language.
_LANG_SAMPLE = 40


def _language_from_titles(titles: list[str]) -> str | None:
    """Language from what the channel actually publishes.

    Much more reliable than the channel's own name: plenty of Chinese and
    Japanese channels use a romanised name \u2014 "Dcard Video", "GQ Taiwan",
    "Taiwan Bar", "marasy8" \u2014 and reading the name alone tags them English
    despite every video being CJK. Japanese is told apart by kana, which Chinese
    doesn't use.
    """
    import re

    if not titles:
        return None
    kana = sum(1 for t in titles if re.search(r'[\u3040-\u309f\u30a0-\u30ff]', t)) / len(titles)
    if kana > 0.5:
        return "japanese"
    cjk = sum(1 for t in titles if re.search(r'[\u4e00-\u9fff\u3400-\u4dbf]', t)) / len(titles)
    if cjk > 0.5:
        return "chinese"
    return "english"


def _language_tag(title: str) -> str | None:
    """Language from the channel name's script.

    Only a fallback for channels with no videos yet \u2014 see _language_from_titles.
    """
    import re

    if re.search(r'[\u4e00-\u9fff\u3400-\u4dbf]', title):
        return "chinese"
    if re.search(r'[\u3040-\u309f\u30a0-\u30ff]', title):
        return "japanese"
    if all(ord(c) < 128 for c in title if not c.isspace()) and len(title) > 3:
        return "english"
    return None


def llm_label_channel(
    title: str,
    description: str,
    topics: list[str] | None,
    video_titles: list[str] | None = None,
) -> dict:
    """Ask the LLM to label a channel against the seed vocabulary.

    Returns {"main": [...], "suggested": [...]}. Only seed main/language labels
    are allowed in "main"; anything else the model returns (a seed sub, or an
    invented one) is demoted to a suggestion. Language falls back to the
    deterministic video-title detector if the model omits one or the call fails.
    """
    from app import llm

    user = (
        f"Channel name: {title}\n"
        f"YouTube topic hints: {', '.join(topics) if topics else 'none'}\n"
        f"Description:\n{description or '(no description)'}"
    )
    raw_main: list[str] = []
    raw_sug: list[str] = []
    try:
        out = llm.chat_json(_label_system_prompt(), user)
        raw_main = [str(x).lower().strip() for x in out.get("main", []) if str(x).strip()]
        raw_sug = [str(x).lower().strip() for x in out.get("suggested", []) if str(x).strip()]
    except Exception as e:  # missing key / API error / bad JSON — degrade, don't crash
        print(f"[tags] LLM labelling failed for {title!r}: {e}")

    # Only real main/language labels get applied; the rest become suggestions.
    main = [l for l in raw_main if l in MAIN_LABELS]
    demoted = [l for l in raw_main if l not in MAIN_LABELS]

    # Language fallback: if the model gave no language, detect it deterministically.
    if not any(l in LANGUAGE_LABELS for l in main):
        lang = _language_from_titles(video_titles or []) or _language_tag(title or "")
        if lang:
            main.append(lang)

    main = list(dict.fromkeys(main))
    suggested = [l for l in dict.fromkeys(raw_sug + demoted) if l not in main]
    return {"main": main, "suggested": suggested}


def _stored_labels(channel) -> dict | None:
    import json
    try:
        return json.loads(channel.llm_labels) if channel.llm_labels else None
    except (ValueError, TypeError):
        return None


async def assign_auto_tags(db: AsyncSession, channels, force: bool = False) -> int:
    """(Re)label the given channels via the LLM and write their applied tags.

    For each channel: reuse the stored LLM verdict unless `force` (then re-call
    the API and re-store it). Main labels become applied auto tags, skipping any
    the user removed (rejections) or added by hand (manual). Suggestions live in
    the stored verdict and are surfaced by channel_suggestions(). Commits per
    channel so a long batch saves progress. Returns applied-tag count.
    """
    import asyncio
    import json

    from sqlalchemy import delete as sa_delete

    rejected: dict[str, set[str]] = {}
    for r in (await db.execute(select(ChannelTagRejection))).scalars().all():
        rejected.setdefault(r.channel_id, set()).add(r.tag_name)
    manual: dict[str, set[str]] = {}
    for r in (
        await db.execute(select(ChannelTag).where(ChannelTag.auto_assigned == 0))
    ).scalars().all():
        manual.setdefault(r.channel_id, set()).add(r.tag_name)

    loop = asyncio.get_event_loop()
    assigned = 0
    for ch in channels:
        labels = None if force else _stored_labels(ch)
        if labels is None:
            sample = [
                r[0] for r in (
                    await db.execute(
                        select(Video.title)
                        .where(Video.channel_id == ch.youtube_id)
                        .order_by(Video.published_at.desc())
                        .limit(_LANG_SAMPLE)
                    )
                ).all()
            ]
            labels = await loop.run_in_executor(
                None, llm_label_channel, ch.title, ch.description,
                _channel_topics(ch), sample,
            )

        row = await db.get(Channel, ch.youtube_id)
        if row is None:
            continue
        row.llm_labels = json.dumps(labels, ensure_ascii=False)

        await db.execute(
            sa_delete(ChannelTag).where(
                ChannelTag.channel_id == ch.youtube_id,
                ChannelTag.auto_assigned == 1,
            )
        )
        skip = rejected.get(ch.youtube_id, set()) | manual.get(ch.youtube_id, set())
        for tag_name in labels.get("main", []):
            if tag_name in skip:
                continue
            db.add(ChannelTag(
                channel_id=ch.youtube_id, tag_name=tag_name, auto_assigned=1
            ))
            assigned += 1
        await db.commit()

    return assigned


# Background re-tag: labelling all channels calls the LLM once each, which takes
# minutes — far too long for a request. Run it in a thread like the scanner.
_retagging = False


async def _retag_all(force: bool):
    from app.database import async_session
    async with async_session() as db:
        channels = list((await db.execute(select(Channel))).scalars().all())
        await assign_auto_tags(db, channels, force=force)


@router.post("/auto-assign")
async def auto_assign_tags(force: bool = Query(default=True)):
    """Kick off a background re-tag of every channel via the LLM.

    force=true re-calls the API for all channels; force=false only labels ones
    without a stored verdict.
    """
    import asyncio
    import threading

    global _retagging
    if _retagging:
        return {"status": "already_running"}

    def _run():
        global _retagging
        try:
            asyncio.run(_retag_all(force=force))
        finally:
            _retagging = False

    _retagging = True
    threading.Thread(target=_run, daemon=True).start()
    return {"status": "started"}


@router.get("/auto-assign/status")
async def auto_assign_status():
    return {"running": _retagging}


async def channel_suggestions(db: AsyncSession, channel: Channel) -> list[str]:
    """Tags offered for one-click add on a channel.

    Two sources: the LLM's suggested sub-labels for this channel (from the stored
    verdict), plus any tag the user removed — removing demotes a tag back to a
    suggestion rather than burying it. Applied tags are excluded.
    """
    applied = {
        r[0] for r in (
            await db.execute(
                select(ChannelTag.tag_name).where(
                    ChannelTag.channel_id == channel.youtube_id
                )
            )
        ).all()
    }
    rejected = {
        r[0] for r in (
            await db.execute(
                select(ChannelTagRejection.tag_name).where(
                    ChannelTagRejection.channel_id == channel.youtube_id
                )
            )
        ).all()
    }
    stored = _stored_labels(channel) or {}
    qualifies = set(stored.get("suggested", []))
    return sorted((qualifies | rejected) - applied)


@router.post("/{channel_id}/tag/{tag_name}")
async def add_channel_tag(
    channel_id: str, tag_name: str, db: AsyncSession = Depends(get_db)
):
    """Apply a tag to a channel (accepting a suggestion, or adding any label).

    Stored as manual (auto_assigned=0) so re-tagging never clobbers it, and any
    prior removal of this tag is cleared.
    """
    from sqlalchemy import delete as sa_delete

    channel = (
        await db.execute(select(Channel).where(Channel.youtube_id == channel_id))
    ).scalar_one_or_none()
    if not channel:
        raise HTTPException(404, "Channel not found")

    await db.execute(
        sa_delete(ChannelTagRejection).where(
            ChannelTagRejection.channel_id == channel_id,
            ChannelTagRejection.tag_name == tag_name,
        )
    )
    exists = (
        await db.execute(
            select(ChannelTag).where(
                ChannelTag.channel_id == channel_id, ChannelTag.tag_name == tag_name
            )
        )
    ).scalar_one_or_none()
    if not exists:
        db.add(ChannelTag(channel_id=channel_id, tag_name=tag_name, auto_assigned=0))
    await db.commit()

    return {"status": "ok", "suggested": await channel_suggestions(db, channel)}


@router.delete("/{channel_id}/tag/{tag_name}")
async def remove_channel_tag(
    channel_id: str, tag_name: str, db: AsyncSession = Depends(get_db)
):
    """Remove a tag from a channel; it becomes a suggestion again.

    Auto-derived tags get a rejection tombstone so the next re-tag doesn't just
    put them back. Manual tags need none — they're only there because the user
    added them.
    """
    from sqlalchemy import delete as sa_delete

    channel = (
        await db.execute(select(Channel).where(Channel.youtube_id == channel_id))
    ).scalar_one_or_none()
    if not channel:
        raise HTTPException(404, "Channel not found")

    row = (
        await db.execute(
            select(ChannelTag).where(
                ChannelTag.channel_id == channel_id, ChannelTag.tag_name == tag_name
            )
        )
    ).scalar_one_or_none()
    if row:
        was_auto = row.auto_assigned == 1
        await db.execute(
            sa_delete(ChannelTag).where(
                ChannelTag.channel_id == channel_id, ChannelTag.tag_name == tag_name
            )
        )
        if was_auto:
            db.add(ChannelTagRejection(channel_id=channel_id, tag_name=tag_name))
        await db.commit()

    return {"status": "ok", "suggested": await channel_suggestions(db, channel)}


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
    window: str = "3d",
    sort: str = Query(default="likes", description="score | views | likes | like% | newest | oldest"),
    time_mode: str = Query(default="wide", description="narrow | wide"),
    shorts: bool = Query(default=False, description="show Shorts instead of long-form videos"),
    include_hidden: bool = Query(default=False, description="include channels hidden from home (peek mode)"),
    offset: int = 0,     # pagination: index into the ranked list
    limit: int = 60,     # pagination: page size
    db: AsyncSession = Depends(get_db),
):
    """Get ranked videos filtered by tags.

    Logic: OR within a tag group (section), AND across groups.
    e.g. selecting coding+flutter (both 開發) AND piano (音樂) returns
    channels tagged (coding OR flutter) AND piano.
    """
    from datetime import datetime

    from app.ranking import WINDOW_RANGES, TimeWindow, rank_videos

    tag_list = [t.strip() for t in tags.split(",") if t.strip()]

    if tag_list:
        # Group selected tags by their section (OR within a group, AND across).
        groups: dict[str, list[str]] = {}
        for tag in tag_list:
            group = TAG_GROUP.get(tag, "__ungrouped__")
            groups.setdefault(group, []).append(tag)

        # For each group: union of channel IDs (OR within group)
        # Then intersect across groups (AND across groups)
        channel_ids: set[str] | None = None
        for group_tags in groups.values():
            stmt = select(ChannelTag.channel_id).where(
                ChannelTag.tag_name.in_(group_tags)
            ).distinct()
            result = await db.execute(stmt)
            group_channels = {r[0] for r in result}
            channel_ids = group_channels if channel_ids is None else channel_ids & group_channels
        channel_ids = channel_ids or set()
    else:
        result = await db.execute(select(Channel.youtube_id))
        channel_ids = {r[0] for r in result}

    # Exclude channels the user hid from home, so they never come down the wire.
    # `include_hidden` (the sidebar "show hidden" peek) bypasses this.
    if not include_hidden:
        hidden = {r[0] for r in await db.execute(select(HiddenChannel.channel_id))}
        channel_ids = channel_ids - hidden

    # Only fetch videos within the window's widest extent so wide windows
    # (6m, 1y) actually differ. A flat "2000 most recent" made them identical:
    # the newest ~2000 videos all fall within ~3 months, so the window filter
    # (applied afterwards) never reached the older 6m–1y videos.
    # published_at is stored as naive UTC, so compare against a naive cutoff.
    # Ranking (score / like%) depends on the whole windowed set, so we must fetch
    # and rank all of it, then return just the requested page. 10000 is a safety
    # cap far above any realistic window.
    tw = TimeWindow(window)
    cutoff = datetime.utcnow() - WINDOW_RANGES[tw][1]
    stmt = select(Video).where(
        Video.channel_id.in_(channel_ids),
        Video.published_at >= cutoff,
        Video.is_short == shorts,
    ).order_by(Video.published_at.desc()).limit(10000)
    result = await db.execute(stmt)
    all_videos = result.scalars().all()

    # Include channel names
    chan_result = await db.execute(select(Channel.youtube_id, Channel.title, Channel.thumbnail_url))
    chan_rows = chan_result.all()
    chan_titles = {r.youtube_id: r.title for r in chan_rows}
    chan_thumbs = {r.youtube_id: r.thumbnail_url for r in chan_rows}

    ranked = rank_videos(list(all_videos), tw, chan_titles, sort=sort, time_mode=time_mode, channel_thumbnails=chan_thumbs)
    return {
        "window": window,
        "sort": sort,
        "time_mode": time_mode,
        "tags": tag_list,
        "videos": ranked[offset:offset + limit],
        "total": len(ranked),
        "offset": offset,
    }