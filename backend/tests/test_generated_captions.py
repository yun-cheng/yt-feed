"""Captions we make ourselves, for the videos YouTube gave none for.

The engine is Whisper on a GPU; none of it runs here. Every test patches
`asr.transcribe_window`, which is the seam the whole feature is built around —
above it there is nothing that knows what a model is, only windows of audio going
in and cues on the video's clock coming out.

What is worth pinning down is the JOB, because it is the part with opinions: that
it walks forward, that it takes Whisper's own segment boundary as the seam rather
than the window it asked for, that it survives a window of silence, that a
finished track reaches every reader of captions while a half-finished one reaches
none of them, and that a failure is a state you can see rather than a spinner.
"""

import asyncio
import json

import pytest

from app import asr
from app.config import settings
from app.models import GeneratedCaptions
from app.routers import feed


def cue(start, dur, text):
    return {"start": start, "dur": dur, "text": text,
            "words": [{"t": start, "text": text}]}


@pytest.fixture(autouse=True)
def a_transcribable_video(monkeypatch, tmp_path):
    """No download, no ffprobe, no model — a ten-minute file that isn't there."""
    monkeypatch.setattr(asr, "available", lambda: True)
    monkeypatch.setattr(feed, "_asr_source", _fake_source(tmp_path))
    monkeypatch.setattr(asr, "duration_of", lambda path: 600.0)


def _fake_source(tmp_path):
    async def _source(video_id: str) -> str:
        p = tmp_path / f"{video_id}.m4a"
        p.write_bytes(b"not really audio")
        return str(p)
    return _source


def transcriber(monkeypatch, fn):
    """Install a fake `transcribe_window` and record every call it gets."""
    calls = []

    def _run(path, start, seconds, language=None):
        calls.append({"start": start, "seconds": seconds, "language": language})
        return fn(start, seconds, language)

    monkeypatch.setattr(asr, "transcribe_window", _run)
    return calls


def speaking(start, seconds, language=None):
    """A window that transcribes cleanly, ending exactly where it was asked to."""
    end = start + seconds
    return {"cues": [cue(start, seconds, f"line at {start:.0f}")],
            "language": "zh", "end": end}


async def finish(client, video_id="vid1"):
    """Start a job and wait for it to leave `running`."""
    r = await client.post(f"/api/feed/captions-generate/{video_id}")
    assert r.status_code == 200, r.text
    task = feed._asr_jobs.get(video_id)
    if task:
        await task
    return (await client.get(f"/api/feed/captions-generate/{video_id}")).json()


async def test_it_walks_the_whole_video_and_says_it_is_done(client, monkeypatch):
    calls = transcriber(monkeypatch, speaking)
    body = await finish(client)
    assert body["status"] == "done"
    assert body["covered"] == 600.0
    assert body["lang"] == "zh"
    # Every window between 0 and the end, and none past it.
    assert calls[0]["start"] == 0
    assert max(c["start"] for c in calls) < 600.0
    assert [c["text"] for c in body["cues"]][:2] == ["line at 0", "line at 30"]


async def test_the_windows_start_small_then_grow(client, monkeypatch):
    """The first caption is the only latency anybody feels, so the first window
    is the short one; the later ones climb to amortise the per-call overhead."""
    calls = transcriber(monkeypatch, speaking)
    await finish(client)
    assert [c["seconds"] for c in calls[:4]] == [30, 60, 120, 120]


async def test_the_language_is_detected_once_and_then_pinned(client, monkeypatch):
    """Detection on a window of music can land anywhere, and a stretch of the
    wrong script is worse than a slow one."""
    calls = transcriber(monkeypatch, speaking)
    await finish(client)
    assert calls[0]["language"] is None
    assert {c["language"] for c in calls[1:]} == {"zh"}


async def test_the_seam_is_where_whisper_stopped_not_where_we_asked(client, monkeypatch):
    """A window boundary that fell mid-word would cut a word in half twice over
    — once at the end of one window and once at the start of the next. Whisper
    says where its last complete segment ended, and that is where we resume."""
    def ragged(start, seconds, language=None):
        end = start + seconds - 3.5  # it stopped short, mid-sentence
        return {"cues": [cue(start, seconds - 3.5, "…")], "language": "zh", "end": end}

    calls = transcriber(monkeypatch, ragged)
    await finish(client)
    assert calls[1]["start"] == pytest.approx(26.5)
    assert calls[2]["start"] == pytest.approx(83.0)


async def test_a_silent_window_still_moves_forward(client, monkeypatch):
    """Music, or a gap. It produces no cues and no segment end — and must not
    leave the job asking the same question forever."""
    def silent_then_speech(start, seconds, language=None):
        if start < 100:
            return {"cues": [], "language": "", "end": start + seconds}
        return speaking(start, seconds, language)

    transcriber(monkeypatch, silent_then_speech)
    body = await asyncio.wait_for(finish(client), timeout=10)
    assert body["status"] == "done"
    assert body["cues"] and body["cues"][0]["start"] >= 100


async def test_progress_is_readable_while_it_runs(client, monkeypatch):
    """Nobody is holding a stream, so how far it reaches has to be written down
    — it is both the progress bar and where a resumed job picks up."""
    seen = asyncio.Event()

    def slow(start, seconds, language=None):
        if start > 0:
            seen.set()
        return speaking(start, seconds, language)

    transcriber(monkeypatch, slow)
    await client.post("/api/feed/captions-generate/vid1")
    await asyncio.wait_for(seen.wait(), timeout=10)
    mid = (await client.get("/api/feed/captions-generate/vid1")).json()
    assert mid["duration"] == 600.0
    assert mid["covered"] > 0
    await feed._asr_jobs["vid1"]


async def test_pressing_it_twice_joins_the_job_rather_than_racing_it(client, monkeypatch):
    calls = transcriber(monkeypatch, speaking)
    await client.post("/api/feed/captions-generate/vid1")
    await client.post("/api/feed/captions-generate/vid1")
    await feed._asr_jobs["vid1"]
    starts = [c["start"] for c in calls]
    assert len(starts) == len(set(starts))  # nothing transcribed twice


async def test_a_finished_track_is_served_as_ordinary_captions(client, monkeypatch):
    """The whole point. Nothing downstream learns that a track can be generated
    — the transcript panel, Ask and the summaries all read /captions."""
    transcriber(monkeypatch, speaking)
    monkeypatch.setattr(feed, "_caption_tracks", lambda vid: _empty_tracks())
    await finish(client)
    feed._cc_cache.clear()

    body = (await client.get("/api/feed/captions/vid1")).json()
    assert body["lang"] == "zh"
    assert [c["text"] for c in body["cues"]][:1] == ["line at 0"]


async def test_a_half_finished_track_is_served_to_nobody(client, monkeypatch, db):
    """A summary written from the first four minutes of a video would be
    confidently wrong, and nothing downstream can tell a partial track from a
    whole one — so `done` is the only status /captions will read."""
    db.add(GeneratedCaptions(
        video_id="vid1", model=settings.asr_model, lang="zh", status="running",
        covered=120.0, duration=600.0,
        cues=json.dumps([cue(0, 5, "only the beginning")]),
    ))
    await db.commit()
    monkeypatch.setattr(feed, "_caption_tracks", lambda vid: _empty_tracks())
    feed._cc_cache.clear()

    assert (await client.get("/api/feed/captions/vid1")).json()["cues"] == []
    # It is still readable AS a job, which is how the page draws its progress.
    assert (await client.get("/api/feed/captions-generate/vid1")).json()["covered"] == 120.0


async def test_the_language_menu_offers_what_we_made(client, monkeypatch):
    """Note the stub: a video with no captions doesn't fail extraction, it
    succeeds and yields ({}, {}, None) — a perfectly truthy tuple. Testing this
    against a None would pass while the menu stayed empty in real life, which is
    exactly what it did."""
    transcriber(monkeypatch, speaking)
    monkeypatch.setattr(feed, "_caption_tracks", lambda vid: _empty_tracks())
    await finish(client)
    feed._ct_cache.clear()

    langs = (await client.get("/api/feed/caption-langs/vid1")).json()["langs"]
    assert langs == [{"code": "zh", "label": "中文", "generated": True}]


async def test_the_generated_track_is_the_native_one_when_there_is_no_other(client, monkeypatch):
    """`native` is what /captions serves when nothing is asked for, and that is
    the generated track — the menu ticks it on that basis."""
    transcriber(monkeypatch, speaking)
    monkeypatch.setattr(feed, "_caption_tracks", lambda vid: _empty_tracks())
    await finish(client)
    feed._ct_cache.clear()
    assert (await client.get("/api/feed/caption-langs/vid1")).json()["native"] == "zh"


async def test_a_video_youtube_does_caption_is_left_alone(client, monkeypatch):
    """The fallback fires only where there is nothing to fall back from."""
    monkeypatch.setattr(feed, "_caption_tracks",
                        lambda vid: _tracks({"en": [{"ext": "json3", "url": "u"}]}))
    langs = (await client.get("/api/feed/caption-langs/vid1")).json()["langs"]
    assert langs == [{"code": "en", "label": "English"}]


async def test_a_stuck_model_does_not_fill_the_screen_with_one_line(client, monkeypatch):
    """Whisper's loop failure: over music or silence it latches onto a token and
    emits it until the window ends. Real speech does repeat a phrase now and
    then, so only an immediate repeat is dropped — and the timeline is untouched,
    because the cue being repeated is already on screen."""
    def stuck(start, seconds, language=None):
        return {
            "cues": [cue(start, 1, "那麽"), cue(start + 1, 1, "那麽"),
                     cue(start + 2, 1, "那麽"), cue(start + 3, 1, "and then on")],
            "language": "zh", "end": start + seconds,
        }

    # The real filter lives in asr.transcribe_window, which the fakes replace —
    # so exercise it directly, on the segments a looping model would return.
    monkeypatch.setattr(asr, "_decode", lambda path, start, seconds: [0.0] * 16000)

    class _Fake:
        @staticmethod
        def transcribe(audio, **kw):
            return {"language": "zh", "segments": [
                {"start": 0.0, "end": 1.0, "text": " 那麽"},
                {"start": 1.0, "end": 2.0, "text": "那麽 "},
                {"start": 2.0, "end": 3.0, "text": "那麽"},
                {"start": 3.0, "end": 4.0, "text": "and then on"},
            ]}

    monkeypatch.setitem(__import__("sys").modules, "mlx_whisper", _Fake)
    out = asr.transcribe_window("nowhere.m4a", 10.0, 30.0, "zh")
    # 那麽 comes back as 那麼: the conversion runs BEFORE the repeat check, or the
    # comparison is between a converted cue and a raw segment and every repeat
    # walks straight past it.
    assert [c["text"] for c in out["cues"]] == ["那麼", "and then on"]
    # The dropped run still counts as time transcribed, or the job would ask for
    # it again forever.
    assert out["end"] == 14.0


def test_mandarin_comes_back_in_traditional_characters():
    """Whisper writes Simplified for Mandarin whatever the speaker's script. The
    prompt shifts most of it and the vocabulary with it, but a measured run still
    mixed seventeen Simplified characters into the Traditional — and a transcript
    in two scripts at once is worse than one consistently in the wrong one. So
    the prompt sets the register and the conversion guarantees the script."""
    out = asr._to_traditional("最近看到了一篇论文,两组人在现场看画")
    assert out == "最近看到了一篇論文,兩組人在現場看畫"
    # Idempotent, so a track that was already Traditional is left alone...
    assert asr._to_traditional(out) == out
    # ...and it is not a Chinese-only pass gone wrong on everything else.
    assert asr._to_traditional("hello world 2026") == "hello world 2026"


def test_a_long_segment_becomes_several_caption_lines():
    """Whisper segments on breath and pause, not on what you can read at a
    glance: the measured tail on a real video was 92 characters over 15.9
    seconds, five clauses in one block."""
    text = ("最近看到了一篇論文,作者喬治紐曼發現了一個有趣的現象,"
            "他做了一組對照實驗,兩組人在現場看畫。")
    words = [{"text": ch, "start": 10.0 + i * 0.2, "end": 10.2 + i * 0.2}
             for i, ch in enumerate(text)]
    cues = asr.split_line(text, words, 10.0, 10.0 + len(text) * 0.2)

    assert len(cues) > 1
    assert all(asr._columns(c["text"]) <= asr.MAX_LINE_COLUMNS * asr.OVERFLOW_TOLERANCE
               for c in cues)
    # Nothing is lost or reordered in the cutting.
    assert "".join(c["text"] for c in cues) == text
    # Each line starts when its own first word is spoken — the whole reason the
    # word timestamps are worth their 28%.
    assert cues[0]["start"] == 10.0
    assert cues[1]["start"] > cues[0]["start"]
    assert all(b["start"] >= a["start"] for a, b in zip(cues, cues[1:]))


def test_lines_are_cut_at_punctuation_not_at_the_ruler():
    """A break mid-clause is what makes a caption hard to read, so the width is
    a budget for choosing between punctuation marks rather than a place to cut."""
    text = "他做了一組對照實驗,兩組人在現場看畫,一組不知道這畫是假的複製品。"
    cues = asr.split_line(text, [], 0.0, 12.0)
    assert all(c["text"][-1] in "。，,、" for c in cues[:-1])


def test_short_segments_are_left_exactly_as_they_are():
    """The median cue was already fine at 12 characters — this only touches the
    tail, and a filter that rewrote every line would be a worse trade."""
    cues = asr.split_line("這很正常", [], 5.0, 7.0)
    assert len(cues) == 1
    assert cues[0]["text"] == "這很正常"
    assert (cues[0]["start"], cues[0]["dur"]) == (5.0, 2.0)


def test_a_line_with_no_punctuation_at_all_still_gets_cut():
    """Some speech simply arrives without any, and one unreadable line is not an
    acceptable answer."""
    cues = asr.split_line("a" * 200, [], 0.0, 20.0)
    assert len(cues) > 1
    assert all(asr._columns(c["text"]) <= asr.MAX_LINE_COLUMNS for c in cues)


def test_without_word_timing_the_span_is_shared_out_by_length():
    """Wrong by a fraction of a second, and still far better than one 16-second
    cue — so a track with no word stream is split too."""
    text = "一組不知道這畫是假的複製品,而另一組知道,結果那一組人的評價普遍都比較低。"
    cues = asr.split_line(text, [], 0.0, 12.0)
    assert len(cues) > 1
    assert cues[0]["start"] == 0.0
    assert abs((cues[-1]["start"] + cues[-1]["dur"]) - 12.0) < 0.5
    assert all(b["start"] >= a["start"] + a["dur"] - 0.01 for a, b in zip(cues, cues[1:]))


async def test_a_failure_is_a_state_you_can_see(client, monkeypatch):
    """Not a spinner that never stops. The row is the only place a job that died
    can say so."""
    def boom(start, seconds, language=None):
        raise RuntimeError("the GPU fell over")

    transcriber(monkeypatch, boom)
    body = await finish(client)
    assert body["status"] == "error"
    assert "GPU fell over" in body["error"]


async def test_a_server_without_the_model_says_so_plainly(client, monkeypatch):
    monkeypatch.setattr(asr, "available", lambda: False)
    r = await client.post("/api/feed/captions-generate/vid1")
    assert r.status_code == 501
    assert (await client.get("/api/feed/captions-generate/vid1")).json()["supported"] is False


async def test_a_job_the_restart_killed_reads_as_stalled_not_running(client, db):
    """`running` with nothing running is a lie the page would spin on forever."""
    db.add(GeneratedCaptions(
        video_id="vid1", model=settings.asr_model, status="running",
        covered=90.0, duration=600.0, cues="[]",
    ))
    await db.commit()
    body = (await client.get("/api/feed/captions-generate/vid1")).json()
    assert body["status"] == "stalled"


async def test_it_resumes_where_the_dead_job_stopped(client, monkeypatch, db):
    """The cues already paid for are kept; the audio is the cheap part."""
    db.add(GeneratedCaptions(
        video_id="vid1", model=settings.asr_model, lang="zh", status="running",
        covered=200.0, duration=600.0, cues=json.dumps([cue(0, 5, "from before")]),
    ))
    await db.commit()
    calls = transcriber(monkeypatch, speaking)
    body = await finish(client)
    assert calls[0]["start"] == 200.0
    assert body["cues"][0]["text"] == "from before"


async def _none():
    return None


async def _empty_tracks():
    """What a video with no captions actually returns: no subs, no auto, no
    source language — and not a falsy value in sight."""
    return {}, {}, None


async def _tracks(subs):
    return subs, {}, None
