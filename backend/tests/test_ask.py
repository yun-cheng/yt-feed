"""Ask — the conversation about a video, and what it is allowed to read.

The parts worth pinning are the ones that decide what the model SEES: a window
that follows the play head when the transcript is too long, a system turn that
admits when it was trimmed, and a thread that belongs to one person. The model
itself is stubbed — this suite is about the prompt and the plumbing around it.
"""

import json

import pytest

from app import llm, users
from app.models import Channel, ChatMessage, User, Video
from app.routers.ask import build_system, clock, transcript_window


def sent(start, text, end=None):
    return {"start": start, "end": end if end is not None else start + 3, "text": text}


# ── clock ────────────────────────────────────────────────────────────


def test_a_short_video_reads_as_minutes_and_seconds():
    assert clock(0) == "0:00"
    assert clock(9) == "0:09"
    assert clock(754) == "12:34"


def test_an_hour_in_and_the_hour_shows():
    assert clock(3600) == "1:00:00"
    assert clock(7384) == "2:03:04"


def test_a_negative_position_is_the_start_not_a_stray_minus():
    assert clock(-5) == "0:00"


# ── transcript_window ────────────────────────────────────────────────


def test_every_line_carries_the_timestamp_it_is_spoken_at():
    """The whole citation mechanism rests on this: the model can only quote a
    timestamp back if it saw one attached to the words."""
    text, *_ = transcript_window([sent(0, "hello"), sent(754, "the pricing bit")], 0)
    assert text == "[0:00] hello\n[12:34] the pricing bit"


def test_a_transcript_that_fits_goes_in_whole():
    sents = [sent(i * 3, f"line {i}") for i in range(50)]
    text, lo, hi, truncated = transcript_window(sents, 0)
    assert truncated is False
    assert len(text.splitlines()) == 50
    assert (lo, hi) == (0, 147)


def test_no_transcript_is_no_window_rather_than_a_crash():
    assert transcript_window([], 12.0) == ("", 0.0, 0.0, False)


def test_an_overlong_transcript_is_trimmed_around_the_play_head():
    """A video too long to send whole is answered where you are standing — the
    same call the translation endpoint makes, for the same reason."""
    sents = [sent(i * 3, f"line {i} " + "x" * 40) for i in range(400)]
    text, lo, hi, truncated = transcript_window(sents, at=600, budget=2_000)
    assert truncated is True
    # 600s is line 200; the kept span surrounds it rather than starting at 0.
    assert lo < 600 < hi
    assert "[10:00]" in text
    assert "[0:00] line 0" not in text
    assert len(text) <= 2_000


def test_the_trimmed_window_reports_the_span_it_actually_read():
    sents = [sent(i * 3, f"line {i} " + "x" * 40) for i in range(400)]
    text, lo, hi, _ = transcript_window(sents, at=600, budget=2_000)
    assert text.splitlines()[0].startswith(f"[{clock(lo)}]")
    assert text.splitlines()[-1].startswith(f"[{clock(hi)}]")


def test_a_question_at_the_end_of_a_long_video_reaches_the_end():
    """Growing outward alternates, but one-sided at an edge — asking about the
    last minute must not hand over the first."""
    sents = [sent(i * 3, f"line {i} " + "x" * 40) for i in range(400)]
    text, _, hi, _ = transcript_window(sents, at=1_197, budget=2_000)
    assert "line 399" in text
    assert hi == 1_197


# ── build_system ─────────────────────────────────────────────────────


def kwargs(**over):
    base = dict(
        title="A talk", channel="Some Channel", topics=["baseball"], duration=754,
        transcript="[0:00] hello", covered=(0.0, 0.0), truncated=False,
    )
    base.update(over)
    return base


def test_the_prompt_names_the_video_it_is_about():
    s = build_system(**kwargs())
    assert "Some Channel" in s and "A talk" in s and "12:34" in s
    assert "baseball" in s
    assert "[0:00] hello" in s


def test_the_model_is_told_the_transcript_is_all_it_knows():
    s = build_system(**kwargs())
    assert "only thing you know" in s
    assert "general knowledge" in s


def test_a_trimmed_transcript_says_so_in_the_prompt():
    """Left unsaid, a model reading a window answers 'that was never mentioned'
    about a passage it simply wasn't given."""
    s = build_system(**kwargs(covered=(600.0, 900.0), truncated=True))
    assert "10:00" in s and "15:00" in s
    assert "too long to include whole" in s


def test_a_whole_transcript_makes_no_excuses():
    assert "too long" not in build_system(**kwargs())


def test_the_answer_is_asked_for_in_markdown():
    """The panel renders it (lib/markdown), and a summary of a long video is a
    list of sections — prose is the wrong shape for one."""
    assert "Markdown" in build_system(**kwargs())


def test_length_is_the_question_s_to_set():
    """The rule this replaced said 'be brief' full stop, and a request to
    summarise a 40-minute video came back as four sentences — every item past
    the first few silently dropped. What is missing from a summary is invisible,
    which is why the prompt has to name that failure."""
    s = build_system(**kwargs())
    assert "COVERAGE" in s
    assert "name all of them" in s


# ── the endpoint ─────────────────────────────────────────────────────


def stub_captions(monkeypatch, cues):
    async def _cached(video_id, lang):
        return {"cues": cues, "lang": "en"} if cues else None
    monkeypatch.setattr("app.routers.ask._captions_cached", _cached)


def stub_model(monkeypatch, chunks, fail_after=None):
    """A model that yields `chunks`, optionally dying partway through."""
    seen = {}

    async def _stream(system, messages, **kw):
        seen["system"] = system
        seen["messages"] = messages
        for i, c in enumerate(chunks):
            if fail_after is not None and i == fail_after:
                raise llm.LLMError("provider went away")
            yield c

    monkeypatch.setattr(llm, "chat_stream", _stream)
    return seen


def deltas(body: str) -> str:
    """The answer text out of the SSE stream."""
    out = []
    for line in body.splitlines():
        if line.startswith("data:"):
            payload = json.loads(line[5:])
            if "delta" in payload:
                out.append(payload["delta"])
    return "".join(out)


def final(body: str) -> dict:
    for line in body.splitlines():
        if line.startswith("data:"):
            payload = json.loads(line[5:])
            if payload.get("done"):
                return payload
    return {}


CUES = [
    {"start": 0, "dur": 3, "text": "Welcome back."},
    {"start": 3, "dur": 3, "text": "The pricing changed last month."},
]


async def test_a_video_nobody_has_asked_about_has_an_empty_thread(client):
    r = await client.get("/api/ask/vid1")
    assert r.status_code == 200
    assert r.json() == {"messages": []}


async def test_a_video_without_captions_says_why_rather_than_answering(client, monkeypatch):
    stub_captions(monkeypatch, [])
    stub_model(monkeypatch, ["should never run"])
    r = await client.post("/api/ask/vid1", json={"question": "what about pricing?"})
    assert r.status_code == 422
    assert "transcript" in r.json()["detail"]


async def test_an_empty_question_is_refused_before_anything_is_fetched(client, monkeypatch):
    stub_captions(monkeypatch, CUES)
    r = await client.post("/api/ask/vid1", json={"question": "   "})
    assert r.status_code == 400


async def test_the_answer_streams_back_and_both_turns_are_kept(client, monkeypatch, db):
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch, ["It went up ", "in March [0:03]."])

    r = await client.post("/api/ask/vid1", json={"question": "what about pricing?"})
    assert r.status_code == 200
    assert deltas(r.text) == "It went up in March [0:03]."
    assert final(r.text)["truncated"] is False

    thread = (await client.get("/api/ask/vid1")).json()["messages"]
    assert [(m["role"], m["content"]) for m in thread] == [
        ("user", "what about pricing?"),
        ("assistant", "It went up in March [0:03]."),
    ]


async def test_the_transcript_and_the_question_both_reach_the_model(client, monkeypatch, db):
    stub_captions(monkeypatch, CUES)
    db.add(Channel(youtube_id="ch1", title="Some Channel"))
    db.add(Video(
        youtube_id="vid1", channel_id="ch1", title="A talk",
        published_at=__import__("datetime").datetime(2026, 1, 1),
        duration_seconds=754, title_labels=json.dumps(["pricing"]),
    ))
    await db.commit()
    seen = stub_model(monkeypatch, ["ok"])

    await client.post("/api/ask/vid1", json={"question": "what about pricing?"})
    assert "The pricing changed last month." in seen["system"]
    assert "Some Channel" in seen["system"] and "A talk" in seen["system"]
    assert "pricing" in seen["system"]
    assert seen["messages"] == [{"role": "user", "content": "what about pricing?"}]


async def test_the_conversation_so_far_is_carried_into_the_next_question(client, monkeypatch):
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch, ["first answer"])
    await client.post("/api/ask/vid1", json={"question": "what about pricing?"})

    seen = stub_model(monkeypatch, ["second answer"])
    await client.post("/api/ask/vid1", json={"question": "and before that?"})
    assert [m["role"] for m in seen["messages"]] == ["user", "assistant", "user"]
    assert seen["messages"][-1]["content"] == "and before that?"


async def test_a_missing_api_key_is_an_http_error_not_a_broken_stream(client, monkeypatch):
    """The first token is pulled before the response starts precisely so this
    can still be a status code."""
    stub_captions(monkeypatch, CUES)

    async def _stream(system, messages, **kw):
        raise llm.LLMError("OPENROUTER_API_KEY is not set")
        yield  # pragma: no cover — makes it a generator

    monkeypatch.setattr(llm, "chat_stream", _stream)
    r = await client.post("/api/ask/vid1", json={"question": "hi"})
    assert r.status_code == 503
    assert (await client.get("/api/ask/vid1")).json()["messages"] == []


async def test_an_answer_cut_off_partway_keeps_what_arrived(client, monkeypatch):
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch, ["It went up ", "in March"], fail_after=1)

    r = await client.post("/api/ask/vid1", json={"question": "what about pricing?"})
    assert r.status_code == 200
    thread = (await client.get("/api/ask/vid1")).json()["messages"]
    assert thread[-1]["content"] == "It went up "


async def test_clearing_the_thread_empties_it(client, monkeypatch):
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch, ["an answer"])
    await client.post("/api/ask/vid1", json={"question": "what about pricing?"})

    assert (await client.delete("/api/ask/vid1")).status_code == 200
    assert (await client.get("/api/ask/vid1")).json()["messages"] == []


async def test_clearing_one_video_leaves_another_alone(client, monkeypatch):
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch, ["an answer"])
    await client.post("/api/ask/vid1", json={"question": "q1"})
    await client.post("/api/ask/vid2", json={"question": "q2"})

    await client.delete("/api/ask/vid1")
    assert len((await client.get("/api/ask/vid2")).json()["messages"]) == 2


# ── two people ───────────────────────────────────────────────────────


@pytest.mark.no_seeded_user
async def test_a_conversation_belongs_to_whoever_had_it(client, db, monkeypatch):
    me = await users.ensure_local_user(db)
    them = User(google_sub="sub-2", email="them@example.test", api_key=users.new_api_key())
    db.add(them)
    await db.commit()
    mine = {"Authorization": f"Bearer {me.api_key}"}
    theirs = {"Authorization": f"Bearer {them.api_key}"}

    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch, ["an answer"])
    await client.post("/api/ask/vid1", headers=mine, json={"question": "what about pricing?"})

    assert (await client.get("/api/ask/vid1", headers=theirs)).json()["messages"] == []
    await client.delete("/api/ask/vid1", headers=theirs)
    assert len((await client.get("/api/ask/vid1", headers=mine)).json()["messages"]) == 2
