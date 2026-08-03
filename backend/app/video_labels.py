"""Per-channel video labels drawn from video titles by the LLM.

Two phases, kept separate on purpose:

  1. Vocabulary (once per channel) — `build_channel_vocab` samples 500-1000 of
     the channel's videos and asks the LLM to extract this channel's recurring
     topics from their titles (teams, series, games, people, competitions).
     Labels that hit >=2 sampled videos become the channel's vocabulary — the
     filter chips shown on the channel page. Stored on `Channel.video_label_vocab`
     (NULL until built), so it runs once.

  2. Assignment (lazy) — `assign_labels` maps a handful of *rendered* videos onto
     that fixed vocabulary. Only videos the user actually scrolls to get labeled;
     unseen pages stay `NULL`. This bounds cost: the big channels never get fully
     labeled unless browsed.

Unlike the seed taxonomy in routers/tags.py, this vocabulary is free-form and
tailored per channel — there is no shared, cross-channel label set.
"""
from __future__ import annotations

import asyncio
import json
import re
import threading

from sqlalchemy import select

from app import llm
from app.models import Channel, ChannelTag, Video

# Bump when the labeling prompt/logic changes so every channel re-labels itself
# on its next visit (see is_current / the channel-page build trigger).
#   1 — broad + specific labels (sport AND league/tournament)
#   2 — constrained second pass over empties (recovers recall misses)
#   3 — feed channel name + taxonomy themes as grounding context
#   4 — store each video's full labels (keep specific one-offs, e.g. New Zealand)
#   5 — 6 labels per video, capped AFTER canonicalization (4 truncated the
#       league or the second team off "A vs B" match titles)
#   6 — per-channel stop words: the channel's own subject is not a topic
#   7 — those stop words derived up front (tags + a one-shot "what does every
#       video share?" call), and labels matched space/punctuation-insensitively
#   8 — verbatim backstop: vocabulary terms written literally in the title are
#       added regardless of what the labeler recalled that run
LABEL_VERSION = 8

# Titles per LLM call. Small enough to stay well inside the token budget.
BATCH_SIZE = 50
# How many batches to label concurrently. Each is a blocking HTTP call run in a
# worker thread, so this is the parallelism of the whole build.
CONCURRENCY = 8
# Labels kept per video, and the number the prompt asks for — one constant, since
# a prompt and a truncation that disagree lose labels silently (they were 4 and 3,
# and "KT vs HLE" came out filed under KT alone).
#
# Six is the natural shape of the titles this has to handle: game + esports +
# league + both teams + a standout player. Four dropped the league outright on
# some match titles, and filtering is a server-side query on `title_labels`, so a
# dropped label doesn't just shorten a chip row — it removes the video from that
# chip's results.
MAX_LABELS = 6
# A hard bound on what one reply may contain, so a runaway answer can't blow up
# the row or the vocab counts. Deliberately well above MAX_LABELS: the real cap
# is applied LAST, after non-vocab labels are dropped (see assign_labels).
MAX_LABELS_RAW = 12
# A label must appear on at least this many sampled videos to become a chip,
# so one-off titles don't clutter the sidebar.
MIN_VOCAB_COUNT = 2
# Cap the vocabulary hint fed back into each build batch (keeps prompts small).
VOCAB_HINT_LIMIT = 40

# Labels that describe the whole channel, not a single video — the model tends to
# echo these from the channel-theme context. Dropped deterministically (casefold)
# so prompt wording can't let them slip through. Languages + generic descriptors.
_STOP_LABELS = {
    "chinese", "english", "japanese", "korean", "spanish", "indonesian",
    "vlog", "vlogs", "entertainment", "video", "videos", "content", "channel",
    "misc", "other", "general", "youtube", "shorts",
}

# Titles sampled for the one-shot "what does every video here share?" call.
BLANKET_SAMPLE = 40


def _key(label: str) -> str:
    """Match key for a label: casefolded, with spaces and punctuation removed.

    So "League of Legends", "league of legends" and "leagueoflegends" are ONE
    label rather than three — they showed up as separate chips otherwise, and a
    stop word written one way failed to block the same word written another.
    """
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", label.casefold())


def _blanket_labels(channel_title: str | None, tags: list[str], titles: list[str]) -> list[str]:
    """Ask, once, which labels would be true of EVERY video on this channel.

    The channel's own subject makes a useless chip — filter by it and you get the
    channel back — and a wasted label slot. Deriving it up front (rather than
    measuring what the labeler produced) is the whole point: measured coverage of
    a conceptually-universal label swung 81% → 67% across two builds of the same
    1049 videos, because the labeler's recall wobbles, so no threshold on it was
    ever going to be stable.

    One cheap call per build. Returns [] on any failure — the tags-based stops
    still apply, so this degrades to the previous behaviour rather than breaking.
    """
    if not titles:
        return []
    system = (
        "You are given a YouTube channel's name, its themes, and a sample of its "
        "video titles. Name the topic labels that would be true of essentially "
        "EVERY video on this channel — its subject, the thing that makes it this "
        "channel rather than another (an LoL channel: 'League of Legends'; a "
        "one-anime channel: that anime's name). These are labels we must NOT put "
        "on individual videos, because they distinguish nothing. Do NOT include "
        "anything that only some videos share (a league, a team, a season, a "
        "series) — when in doubt, leave it out. Usually 0-2 labels; return an "
        'empty list for a channel with no single subject. Reply as '
        '{"blanket": ["League of Legends"]}.'
    )
    user = f"{_channel_context(channel_title, tags)}\n\nSample titles:\n" + "\n".join(titles)
    try:
        out = llm.chat_json(system, user, max_tokens=512, reasoning=False)
    except Exception as e:  # noqa: BLE001 — best-effort; tags still cover the common case
        print(f"[video_labels] blanket-subject call failed: {e}")
        return []
    raw = out.get("blanket") if isinstance(out, dict) else None
    return [s for x in (raw or []) if (s := str(x).strip())]


def _channel_stops(channel, tags: list[str]) -> set[str]:
    """Every label this channel must not produce, as match keys.

    Three sources: the global list (languages, `vlog`, …), the channel's own
    taxonomy tags — an `esports` channel labeling each video `esports` says
    nothing — and the blanket subjects derived at build time (above), which is
    also where a hand-edited list would live.
    """
    stops = {_key(l) for l in _STOP_LABELS}
    stops |= {_key(t) for t in tags}
    if channel is not None and channel.label_stop_words:
        try:
            stops |= {_key(str(s)) for s in json.loads(channel.label_stop_words)}
        except (ValueError, TypeError):
            pass
    return stops


def is_current(channel) -> bool:
    """True when the channel's vocab is built and at the current LABEL_VERSION."""
    return channel.video_label_vocab is not None and channel.video_label_version == LABEL_VERSION


def _build_prompt(allow_new: bool, stops: set[str] | None = None) -> str:
    base = (
        "You are grouping one YouTube channel's videos into browsable topics. "
        "You are given the channel's name and overall themes as CONTEXT to "
        "interpret ambiguous titles — on a travel channel a place name means a "
        "travel destination (紐西蘭 → travel / new zealand), on a cooking channel "
        "a dish name means that cuisine, on an esports channel a name is a team "
        "or player. But do NOT output a theme as a label just because it's the "
        "channel's theme: never label a video with the channel's language "
        "(chinese, english, japanese, …) or a broad whole-channel descriptor "
        "(vlog, entertainment, videos, content) — those don't distinguish one "
        "video from another. Only output concrete topics specific to the video; "
        "a video with no concrete topic gets none. "
        "For each video, give BOTH its broad category AND any specific recurring "
        "entity it involves, so viewers can filter either way. The broad "
        "category is the sport, game, genre, or subject (football, baseball, "
        "basketball, cooking) — include it whenever the video clearly has one. "
        "The specific entity is a league, tournament, team, player, or series "
        "when clearly present (FIFA世界盃, MLB, T1). For example a FIFA World Cup "
        "match becomes ['football', 'FIFA世界盃']; an MLB game becomes "
        "['baseball', 'MLB']. Infer the category from what the title refers to, "
        "not just its literal words. Each label is a single word or short phrase "
        "(1-3 words): lowercase for generic categories (football, cooking), "
        "natural casing for names and acronyms (MLB, T1, iPhone). Give up to "
        f"{MAX_LABELS} "
        "labels per video; a title with no clear topic gets none. Reuse labels "
        "across videos and never make true duplicates of one concept (football "
        "vs soccer — pick one; but football and FIFA世界盃 are different levels, "
        "so include both)."
    )
    if allow_new:
        base += (
            " Prefer the channel's existing labels when they fit; add a new one "
            "only for a clearly recurring topic they don't cover yet."
        )
    else:
        base += (
            " Use ONLY labels from the channel's existing label list. If none fit "
            "a title, give that video no labels."
        )
    if stops:
        # Spending the budget on a label every video shares is the main way these
        # answers go wrong: the model volunteers the channel's subject and stops
        # short of the teams/entities that actually distinguish one video.
        base += (
            " NEVER output these labels — they describe this whole channel, not "
            "one video, so they distinguish nothing: " + ", ".join(sorted(stops)) + "."
        )
    base += (
        ' Return JSON mapping each video\'s number to its labels, e.g. '
        '{"labels": {"0": ["football"], "1": [], "2": ["basketball", "NBA"]}}.'
    )
    return base


def _channel_context(title: str | None, tags: list[str]) -> str:
    """One-line channel grounding for the prompt: name + its taxonomy themes."""
    themes = ", ".join(tags) if tags else "unknown"
    return f"Channel: {title or 'unknown'}\nChannel's overall themes: {themes}"


def _label_batch(items: list[tuple[str, str]], vocab: list[str], allow_new: bool, channel_ctx: str = "", stops: set[str] | None = None) -> dict[str, list[str]]:
    """Label one batch of (video_id, title). Returns {video_id: [labels]}.

    Degrades to {} on any API/parse error — labeling is best-effort, never fatal.
    """
    if not items:
        return {}
    numbered = "\n".join(f"{i}. {title}" for i, (_vid, title) in enumerate(items))
    vocab_line = ", ".join(vocab) if vocab else "(none yet)"
    header = f"{channel_ctx}\n\n" if channel_ctx else ""
    user = f"{header}Channel's existing labels: {vocab_line}\n\nVideos:\n{numbered}"
    try:
        # reasoning=False is load-bearing, not a tuning knob. Matching 50 titles
        # against a fixed label list is mechanical work, and with reasoning on
        # the model spent the WHOLE budget thinking and returned empty content
        # (finish_reason=length) — so most batches failed, which is what stranded
        # videos with no labels and left the channel page saying "finding topics"
        # for as long as it did.
        out = llm.chat_json(
            _build_prompt(allow_new, stops), user, max_tokens=8192, reasoning=False
        )
    except Exception as e:  # missing key / API error / bad JSON — degrade
        print(f"[video_labels] batch failed: {e}")
        return {}

    raw = out.get("labels", out) if isinstance(out, dict) else {}
    result: dict[str, list[str]] = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            try:
                idx = int(str(k).strip().rstrip("."))
            except (ValueError, TypeError):
                continue
            if 0 <= idx < len(items) and isinstance(v, list):
                # Enforced here as well as in the prompt: asking nicely is not a
                # filter, and a stop word that slips through becomes a chip.
                banned = stops if stops is not None else {_key(l) for l in _STOP_LABELS}
                labels = [
                    s for x in v
                    if (s := str(x).strip()) and _key(s) not in banned
                ][:MAX_LABELS_RAW]
                result[items[idx][0]] = labels
    return result


def _verbatim(title: str, vocab: list[str], stops: set[str]) -> list[str]:
    """Vocabulary terms written LITERALLY in the title.

    The labeler's recall is the weak link — the identical batch at temperature 0
    returned the teams 5/5, 5/5, then 1/5 — and on titles like "DK vs G2 …" or
    "2026 LCK常規賽" the answer is sitting in the text. Matching it costs no
    tokens and never varies, so it backstops the model instead of asking it twice.

    ASCII terms need boundaries (`AL` must not fire inside `GAL`); CJK has no
    word boundaries to speak of, so those match as substrings.
    """
    hits: list[str] = []
    for term in vocab:
        if _key(term) in stops:
            continue
        if term.isascii():
            if re.search(rf"(?<![0-9A-Za-z]){re.escape(term)}(?![0-9A-Za-z])", title, re.I):
                hits.append(term)
        elif term in title:
            hits.append(term)
    return hits


def _canonical(labels: list[str], vocab: list[str]) -> list[str]:
    """Snap labels to the vocabulary's display casing and drop non-vocab ones.

    Keeps chip text and stored labels identical so client-side filtering matches
    exactly (case-insensitively), and dedupes while preserving order.
    """
    by_key = {_key(v): v for v in vocab}
    out: list[str] = []
    for l in labels:
        canon = by_key.get(_key(l))
        if canon and canon not in out:
            out.append(canon)
    return out


def _dedupe(labels: list[str]) -> list[str]:
    """Order-preserving dedupe on the match key (see _key)."""
    out: list[str] = []
    seen: set[str] = set()
    for l in labels:
        if _key(l) not in seen:
            seen.add(_key(l))
            out.append(l)
    return out


def _normalize(labels: list[str], display: dict[str, str]) -> list[str]:
    """Normalize casing to a shared display map and dedupe, keeping ALL labels.

    Unlike _canonical this does NOT drop labels missing from the vocabulary, so a
    video keeps its specific one-off topics (e.g. "New Zealand" on the only NZ
    video) even though they're too rare to be channel-wide filter chips.
    """
    out: list[str] = []
    seen: set[str] = set()
    for l in labels:
        key = _key(l)
        disp = display.get(key, l)
        if _key(disp) not in seen:
            seen.add(_key(disp))
            out.append(disp)
    return out


async def build_channel_vocab(db, channel_id: str) -> list[str]:
    """Phase 1: label every video in the channel and derive its label vocabulary.

    Labels the whole channel (not a sample) so counts are exact and filtering is
    complete. A label must land on >=MIN_VOCAB_COUNT videos to enter the
    vocabulary. Stores the vocabulary on the channel and each video's labels.
    Returns the vocabulary.
    """
    channel = await db.get(Channel, channel_id)
    if channel is None:
        return []

    rows = (
        await db.execute(
            select(Video.youtube_id, Video.title).where(Video.channel_id == channel_id)
        )
    ).all()
    if not rows:
        channel.video_label_vocab = json.dumps([])
        channel.video_label_version = LABEL_VERSION
        await db.commit()
        return []

    # Channel grounding (name + taxonomy themes) helps the model interpret titles.
    tags = [
        r[0] for r in (
            await db.execute(select(ChannelTag.tag_name).where(ChannelTag.channel_id == channel_id))
        ).all()
    ]
    channel_ctx = _channel_context(channel.title, tags)

    # Decided BEFORE any labeling, so the model is told what not to say rather
    # than us pruning it afterwards. Merged into whatever the channel already
    # carries (a previous build's answer, or a hand-edited list).
    blanket = _blanket_labels(channel.title, tags, [r[1] for r in rows[:BLANKET_SAMPLE]])
    if blanket:
        merged = sorted({*json.loads(channel.label_stop_words or "[]"), *blanket}, key=str.casefold)
        channel.label_stop_words = json.dumps(merged, ensure_ascii=False)
        await db.commit()
        print(f"[video_labels] {channel_id}: blanket subjects -> {merged}")
    stops = _channel_stops(channel, tags)

    loop = asyncio.get_event_loop()
    counts: dict[str, list] = {}  # match key -> [display, count]
    per_video: dict[str, list[str]] = {}
    batches = [
        [(r[0], r[1]) for r in rows[start:start + BATCH_SIZE]]
        for start in range(0, len(rows), BATCH_SIZE)
    ]
    # Run batches CONCURRENCY at a time (each _label_batch is a blocking HTTP
    # call in a worker thread). The accumulated vocabulary is fed forward as a
    # hint between chunks so labels converge without going fully sequential.
    for i in range(0, len(batches), CONCURRENCY):
        chunk = batches[i:i + CONCURRENCY]
        hint = [d for d, _c in sorted(counts.values(), key=lambda x: -x[1])][:VOCAB_HINT_LIMIT]
        results = await asyncio.gather(*[
            loop.run_in_executor(None, _label_batch, batch, hint, True, channel_ctx, stops) for batch in chunk
        ])
        for result in results:
            for vid, labels in result.items():
                per_video[vid] = labels
                for lb in labels:
                    key = _key(lb)
                    if key not in counts:
                        counts[key] = [lb, 0]
                    counts[key][1] += 1

    vocab = [
        disp for disp, cnt in sorted(counts.values(), key=lambda x: -x[1])
        if cnt >= MIN_VOCAB_COUNT and _key(disp) not in stops
    ]
    channel.video_label_vocab = json.dumps(vocab, ensure_ascii=False)
    channel.video_label_version = LABEL_VERSION

    # Store each video's FULL labels (not just vocab ones), normalized to a shared
    # display casing — so a video keeps specific one-off topics (New Zealand) that
    # are too rare to be filter chips. Chips still come from `vocab` above.
    display = {key: disp for key, (disp, _cnt) in counts.items()}
    final = {
        vid: _dedupe(
            [l for l in _normalize(per_video.get(vid, []), display) if _key(l) not in stops]
            + _verbatim(title, vocab, stops)
        )[:MAX_LABELS]
        for vid, title in rows
    }

    # Second pass: the open-ended pass has imperfect recall — some clearly-topical
    # titles come back with no labels (the model has to invent them, or a batch's
    # JSON got truncated). Re-label just the empties against the now-known
    # vocabulary, where the model only matches each title to a fixed list. Much
    # higher recall (e.g. a "5天4夜行程" travel vlog that got missed → travel).
    if vocab:
        title_by_id = {vid: t for vid, t in rows}
        empties = [(vid, title_by_id[vid]) for vid, labels in final.items() if not labels]
        retry_batches = [empties[i:i + BATCH_SIZE] for i in range(0, len(empties), BATCH_SIZE)]
        for i in range(0, len(retry_batches), CONCURRENCY):
            chunk = retry_batches[i:i + CONCURRENCY]
            results = await asyncio.gather(*[
                loop.run_in_executor(None, _label_batch, batch, vocab, False, channel_ctx, stops) for batch in chunk
            ])
            for result in results:
                for vid, labels in result.items():
                    norm = _normalize(labels, display)[:MAX_LABELS]
                    if norm:
                        final[vid] = norm

    # Persist every video's labels. A video still empty after both passes has no
    # matching topic — [] means labeled-but-none, not pending.
    for vid, _title in rows:
        row = await db.get(Video, vid)
        if row is not None:
            row.title_labels = json.dumps(final.get(vid, []), ensure_ascii=False)
    await db.commit()
    return vocab


async def assign_labels(db, channel_id: str, video_ids: list[str]) -> dict[str, list[str]]:
    """Phase 2: label the given (rendered) videos against the fixed vocabulary.

    No-ops until the vocabulary exists. Only the LLM-labels videos still NULL (so
    re-rendering a page costs nothing), but returns labels for *every* requested
    id — including ones labeled on an earlier pass — so the caller can refresh its
    in-memory copy in one call. Returns {video_id: [labels]}.
    """
    channel = await db.get(Channel, channel_id)
    vocab = json.loads(channel.video_label_vocab) if channel and channel.video_label_vocab else None
    if not vocab or not video_ids:
        return {}

    rows = (
        await db.execute(
            select(Video.youtube_id, Video.title, Video.title_labels).where(
                Video.youtube_id.in_(video_ids)
            )
        )
    ).all()
    out: dict[str, list[str]] = {}
    todo: list[tuple[str, str]] = []
    for vid, title, stored in rows:
        if stored is None:
            todo.append((vid, title))
        else:
            out[vid] = _labels_or_empty(stored)

    tags = [
        r[0] for r in (
            await db.execute(select(ChannelTag.tag_name).where(ChannelTag.channel_id == channel_id))
        ).all()
    ]
    channel_ctx = _channel_context(channel.title, tags)
    stops = _channel_stops(channel, tags)

    loop = asyncio.get_event_loop()
    for start in range(0, len(todo), BATCH_SIZE):
        batch = todo[start:start + BATCH_SIZE]
        result = await loop.run_in_executor(None, _label_batch, batch, vocab, False, channel_ctx, stops)
        for vid, _title in batch:
            # Only persist videos the batch actually answered for. _label_batch
            # degrades to {} on any failure (dead key, rate limit, JSON truncated
            # by max_tokens), and a video missing from the response is
            # indistinguishable from one the model deliberately gave no labels —
            # so writing [] here turns a transient failure into a PERMANENT
            # answer: `[]` is never re-labeled, only NULL is. Leaving it NULL
            # costs one more attempt the next time the page renders it.
            if vid not in result:
                continue
            title = dict(batch)[vid]
            labels = _dedupe(
                _canonical(result[vid], vocab) + _verbatim(title, vocab, stops)
            )[:MAX_LABELS]
            out[vid] = labels
            row = await db.get(Video, vid)
            if row is not None:
                row.title_labels = json.dumps(labels, ensure_ascii=False)
    if todo:
        await db.commit()
    return out


def _labels_or_empty(raw: str) -> list[str]:
    try:
        val = json.loads(raw)
        return val if isinstance(val, list) else []
    except (ValueError, TypeError):
        return []


# --- Background vocab build -------------------------------------------------
# Phase 1 makes ~10-20 LLM calls, far too long for a request. Run it in a thread
# (like the scanner / channel re-tagger) and let the page poll for completion.
_building: set[str] = set()
_build_lock = threading.Lock()


def is_building(channel_id: str) -> bool:
    return channel_id in _building


def start_build(channel_id: str, force: bool = False) -> dict:
    with _build_lock:
        if channel_id in _building:
            return {"status": "already_running"}
        _building.add(channel_id)

    def _run():
        try:
            asyncio.run(_build_job(channel_id, force))
        except Exception as e:
            print(f"[video_labels] build failed for {channel_id}: {e}")
        finally:
            _building.discard(channel_id)

    threading.Thread(target=_run, daemon=True).start()
    return {"status": "started"}


async def _build_job(channel_id: str, force: bool):
    from app.database import async_session
    async with async_session() as db:
        if not force:
            ch = await db.get(Channel, channel_id)
            if ch and is_current(ch):
                return  # already built at the current version
        await build_channel_vocab(db, channel_id)
