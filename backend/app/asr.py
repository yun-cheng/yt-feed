"""Speech to text for the videos YouTube gave no captions for.

Some videos have no caption track at all — not even YouTube's own ASR. On this
app that's not one missing feature but five: the caption block, the transcript
panel, the AI translation, Ask, and the summaries are all fed by the same timed
cues, so a video without them is dark everywhere at once.

This module makes those cues locally, with Whisper. The important thing it does
NOT do is invent a new shape: `transcribe_window` returns exactly what
`_parse_json3` returns from a YouTube track, so a generated track is served,
rendered, translated, grouped into sentences and read by the model through the
code that already existed. The feature is one new producer, not a second
captions system.

Measured on an M4 with `large-v3-turbo`, on a 12-minute Mandarin video:

    model load (weights cached on disk)   ~2.5s
    throughput, plain                     ~11x realtime
    throughput, with word timestamps      ~8.6x realtime   <- what we run
    per-window fixed overhead             ~0.75s

An end-to-end job on that video, audio download included, held 8.3x.

Two design consequences follow from those numbers, and they are why the windows
ramp rather than being one size:

- Throughput barely varies with window length (10.6x at 60s, 11.9x at 300s
  without word timestamps), so long windows buy almost nothing. What they cost
  is the wait for the FIRST caption, which is the only latency anybody
  experiences: 300s of audio is a good half-minute of blank screen.
- So the first window is short enough to be on screen in about seven seconds,
  and later ones grow to amortise the per-call overhead. Over a two-hour video
  the ramp costs ~8% against fixed 300s windows.

At 8.6x, generation still outruns playback several times over — a two-hour
podcast finishes in about fourteen minutes of background work while you watch a
hundred and twenty. After the first window nobody is ever waiting for this.
"""

from __future__ import annotations

import subprocess
from concurrent.futures import ThreadPoolExecutor

from app.config import settings

# Whisper is one model on one GPU: a second concurrent transcription doesn't run
# twice as fast, it runs both at half speed and doubles the time to the first
# caption on each. One worker makes the queue explicit.
asr_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr")

# How much audio each pass swallows, in seconds. The last value repeats for the
# rest of the video — see the module docstring for why it climbs.
WINDOW_RAMP = (30, 60, 120)

SAMPLE_RATE = 16000


def window_for(index: int) -> int:
    """Seconds of audio for the `index`-th pass over one video."""
    return WINDOW_RAMP[min(index, len(WINDOW_RAMP) - 1)]


def available() -> bool:
    """Whether this server can transcribe at all.

    mlx-whisper is Apple-Silicon only and is not in requirements.txt, so a
    server that hasn't installed it must be able to say so rather than raise:
    the watch page hides the menu item on a False here.
    """
    try:
        import mlx_whisper  # noqa: F401
    except Exception:
        return False
    return True


def _decode(path: str, start: float, seconds: float):
    """Decode one slice of an audio file to the mono 16kHz floats Whisper wants.

    Seeking with ffmpeg rather than loading the file and slicing it: mlx's own
    `load_audio` decodes the WHOLE file, which is a second on a 12-minute video
    and ten on a feature-length one — paid again on every window.

    numpy is imported here rather than at the top because it arrives WITH
    mlx-whisper, which is optional: a server without the model must still be
    able to import this module to answer `available()` with False.
    """
    import numpy as np

    out = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-threads", "0",
            "-ss", f"{start:.3f}", "-t", f"{seconds:.3f}", "-i", path,
            "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le",
            "-ar", str(SAMPLE_RATE), "-",
        ],
        capture_output=True, check=True,
    )
    return np.frombuffer(out.stdout, np.int16).flatten().astype(np.float32) / 32768.0


def duration_of(path: str) -> float:
    """Length of an audio/video file in seconds, or 0 if ffprobe can't say."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, check=True,
        )
        return float(out.stdout.strip())
    except Exception:
        return 0.0


# Where a caption line may break, in preference order: a sentence ending is a
# clean break, a clause mark is an acceptable one.
_SENTENCE_BREAK = "。！？!?…"
_CLAUSE_BREAK = "，,、；;：:）)》」』】"

# How wide one caption line may get, in COLUMNS — a CJK character occupies two
# and everything else one, which is the only way to compare a Chinese line with
# an English one honestly. Forty is about twenty Chinese characters, close to
# what YouTube's own lines run to and comfortably inside the block's width.
#
# Whisper's segments are not caption lines and were never meant to be: the
# measured tail on a real video ran to 92 characters over 15.9 seconds, five
# clauses in one block, because it segments on breath and pause rather than on
# anything you could read at a glance. The median was fine (12 characters); it
# is only the long ones that need cutting.
MAX_LINE_COLUMNS = 40

# Below this, a trailing fragment is glued back onto the line before it rather
# than being left on screen as an orphan of a word or two.
MIN_LINE_COLUMNS = 10

# How far a clause may exceed the budget before it is cut blindly. A clause with
# no punctuation in it has no good break point, and one line a quarter too wide
# reads better than a clean-looking cut through the middle of a phrase followed
# by an orphan — "…的評價普遍" / "都比較低。" being the case that made the point.
OVERFLOW_TOLERANCE = 1.25


def _columns(text: str) -> int:
    """Display width, counting CJK as double."""
    return sum(2 if _is_wide(ch) else 1 for ch in text)


def _is_wide(ch: str) -> bool:
    return any(start <= ch <= end for start, end in (
        ("\u1100", "\u115f"), ("\u2e80", "\ua4cf"), ("\uac00", "\ud7a3"),
        ("\uf900", "\ufaff"), ("\ufe30", "\ufe4f"), ("\uff00", "\uff60"),
        ("\uffe0", "\uffe6"),
    ))


def _chunks(text: str) -> list[str]:
    """Break a line at punctuation, keeping the punctuation on the left piece.

    Sentence marks first: if a segment holds two whole sentences, those are the
    breaks a reader expects. Only when the pieces are still too wide does it fall
    back to clause marks, and only then to a blind cut — which is reserved for
    text that offers no punctuation at all.
    """
    pieces = _split_after(text, _SENTENCE_BREAK)
    if all(_columns(p) <= MAX_LINE_COLUMNS for p in pieces):
        return pieces
    out: list[str] = []
    for piece in pieces:
        if _columns(piece) <= MAX_LINE_COLUMNS:
            out.append(piece)
            continue
        limit = MAX_LINE_COLUMNS * OVERFLOW_TOLERANCE
        for sub in _split_after(piece, _CLAUSE_BREAK):
            out.extend(_hard_wrap(sub) if _columns(sub) > limit else [sub])
    return out


def _split_after(text: str, marks: str) -> list[str]:
    out, buf = [], ""
    for ch in text:
        buf += ch
        if ch in marks:
            out.append(buf)
            buf = ""
    if buf:
        out.append(buf)
    return out or [text]


def _hard_wrap(text: str) -> list[str]:
    """Last resort, for speech that arrives with no punctuation at all: cut at
    the width, at a space where there is one."""
    out, buf = [], ""
    for ch in text:
        buf += ch
        if _columns(buf) >= MAX_LINE_COLUMNS:
            cut = buf.rfind(" ")
            if cut > 0:
                out.append(buf[:cut])
                buf = buf[cut + 1:]
            else:
                out.append(buf)
                buf = ""
    if buf:
        out.append(buf)
    return out


def _pack(pieces: list[str]) -> list[str]:
    """Glue the pieces back into lines as wide as the budget allows.

    Splitting at every comma would give a flicker of two-character lines; the
    point is lines you can read, not the smallest possible ones.
    """
    lines: list[str] = []
    for piece in pieces:
        if lines and _columns(lines[-1] + piece) <= MAX_LINE_COLUMNS:
            lines[-1] += piece
        else:
            lines.append(piece)
    # An orphan at the end reads worse than one over-wide line.
    if len(lines) > 1 and _columns(lines[-1]) < MIN_LINE_COLUMNS:
        lines[-2] += lines.pop()
    return [l.strip() for l in lines if l.strip()]


def split_line(text: str, words: list[dict], start: float, end: float) -> list[dict]:
    """One Whisper segment as one or more caption cues.

    Times come from the word stream where there is one — the reason word
    timestamps are worth their ~28% — so a line appears exactly when its first
    word is spoken rather than at a guessed fraction of the segment. Without
    them it falls back to apportioning the span by character count, which is
    wrong by a fraction of a second and still far better than one 16-second cue.
    """
    text = text.strip()
    if not text:
        return []
    lines = _pack(_chunks(text))
    if len(lines) == 1:
        return [_cue(lines[0], start, end)]

    # Walk the word stream alongside the lines, matching on character count:
    # the words concatenate to (very nearly) the segment text, so the boundary
    # between line n and n+1 falls at the word covering that character offset.
    spans: list[tuple[float, float]] = []
    if words:
        cursor, at = 0, 0
        for line in lines:
            target = cursor + len(line.replace(" ", ""))
            first = at
            while at < len(words) and cursor < target:
                cursor += len(words[at]["text"].strip().replace(" ", ""))
                at += 1
            lo = words[min(first, len(words) - 1)]["start"]
            hi = words[min(at, len(words)) - 1]["end"] if at else lo
            spans.append((lo, hi))
    if len(spans) != len(lines) or any(hi <= lo for lo, hi in spans):
        # No usable word timing: apportion the span by how much text each line
        # holds, which at least keeps the lines in step with the speech.
        total = sum(len(l) for l in lines) or 1
        spans, at = [], start
        for line in lines:
            width = (end - start) * len(line) / total
            spans.append((at, at + width))
            at += width
    return [_cue(line, lo, hi) for line, (lo, hi) in zip(lines, spans)]


def _cue(text: str, start: float, end: float) -> dict:
    start, end = round(float(start), 3), round(float(end), 3)
    return {
        "start": start,
        "dur": round(max(end - start, 0.2), 3),
        "text": text,
        # One "word" at the cue start, which is how `_parse_json3` renders a
        # manual subtitle track: the whole line appears at once. The per-word
        # times exist now and could drive the rolling reveal, but that is the
        # look YouTube's auto-captions have, not one anybody asked for here.
        "words": [{"t": start, "text": text}],
    }


# Whisper writes Simplified for Mandarin whatever the speaker's own script would
# have been. The prompt asks for Traditional, which shifts most of it and, more
# usefully, shifts the VOCABULARY toward Taiwan usage — but only most: a measured
# 60-second run still came back with seventeen Simplified-only characters mixed
# in among the Traditional, and a transcript in two scripts at once is worse than
# one consistently in the wrong script. So the prompt sets the register and
# OpenCC guarantees the script.
_ZH_PROMPT = "以下是繁體中文的字幕，請使用臺灣的用語和標點。"


def _to_traditional(text: str) -> str:
    """Simplified to Traditional, Taiwan phrasing. Idempotent, and a no-op on
    text that is already Traditional or isn't Chinese at all.

    Falls back to the untouched text where OpenCC isn't installed: the prompt
    alone still gets most of the way, and a mostly-Traditional transcript beats
    no transcript.
    """
    try:
        from opencc import OpenCC
    except Exception:
        return text
    global _cc
    if _cc is None:
        _cc = OpenCC("s2twp")
    return _cc.convert(text)


_cc = None


def transcribe_window(
    path: str, start: float, seconds: float, language: str | None = None,
) -> dict:
    """Transcribe `seconds` of `path` from `start`, as cues on the video's clock.

    Returns `{"cues": [...], "language": str, "end": float}` where `end` is where
    the last COMPLETE segment finished — the caller starts the next window there
    rather than at `start + seconds`, so a window boundary never lands mid-word.
    Whisper chooses where its segments break; taking it at its word is what makes
    the seams free.

    `language` pins what a previous window detected. Detection is per-call, and
    on a window that happens to be music or silence it can land somewhere absurd
    and return a stretch of the wrong script — so it is worth doing exactly once.

    Blocking, GPU-bound: call it in `asr_pool`. Tests patch this function; nothing
    above it knows Whisper exists.
    """
    import mlx_whisper

    audio = _decode(path, start, seconds)
    if not len(audio):
        return {"cues": [], "language": language or "", "end": start}

    zh = (language or "").startswith("zh")
    result = mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=settings.asr_model,
        language=language or None,
        verbose=False,
        # Whisper's loop failure: over music or a long silence it will latch onto
        # a token and emit it until the window ends — 44 cues of "有什么事" across
        # eighteen seconds, in the run that caught this. Conditioning on the text
        # so far is what feeds the loop, and turning it off is the standard cure.
        # We lose nothing by it: each window is already an independent call, so
        # there is no cross-window context to preserve either way.
        condition_on_previous_text=False,
        # Worth ~28% (11.0x to 8.6x, measured): it is what lets a long segment be
        # cut into caption lines that appear when their first word is spoken,
        # rather than at a guessed fraction of the segment.
        word_timestamps=True,
        initial_prompt=_ZH_PROMPT if zh else None,
    )
    detected = (result.get("language") or language or "").split("-")[0].lower()
    zh = zh or detected == "zh"

    cues, end = [], start
    for seg in result.get("segments") or []:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        words = [
            {"text": w.get("word", ""),
             "start": start + float(w["start"]), "end": start + float(w["end"])}
            for w in (seg.get("words") or []) if w.get("word", "").strip()
        ]
        # Convert BEFORE the repeat check below, or the comparison is between a
        # converted cue and a raw segment and every repeat walks straight past it.
        if zh:
            text = _to_traditional(text)
            for w in words:
                w["text"] = _to_traditional(w["text"])
        # Belt and braces on the loop above: one that survives the setting still
        # shows up as the same line over and over. Real speech repeats a phrase
        # now and then, so only an IMMEDIATE repeat is dropped — and dropping it
        # leaves the timeline alone, since the cue it repeats is already up.
        if cues and cues[-1]["text"] == text:
            end = round(start + seg["end"], 3)
            continue
        seg_start = start + float(seg["start"])
        seg_end = start + float(seg["end"])
        cues.extend(split_line(text, words, seg_start, seg_end))
        end = round(seg_end, 3)
    return {
        "cues": cues,
        "language": detected,
        # A window that produced nothing (silence, music) must still advance, or
        # the job would sit on it forever asking the same question.
        "end": end if cues else round(start + seconds, 3),
    }
