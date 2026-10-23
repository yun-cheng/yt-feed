"""The AI translation's store: what it keeps, and how a line finds its sentence.

A translation is kept against the sentence it translates, not the sentence's
position, and only when the model actually returned it. Both used to go wrong
the same way you'd see it: a Chinese line showing under the English sentence
before or after its own.
"""

import json

import pytest

from app.models import CaptionTranslation
from app.routers import feed


def cue(start, text):
    return {"start": start, "dur": 2.0, "text": text,
            "words": [{"t": start, "text": text}]}


CUES = [cue(0.0, "One."), cue(2.0, "Two."), cue(4.0, "Three.")]


@pytest.fixture
def captions(monkeypatch):
    async def _cached(video_id, lang):
        return {"cues": CUES, "lang": "en"}
    monkeypatch.setattr(feed, "_captions_cached", _cached)


def translator(monkeypatch, reply):
    """Install a fake `_translate_lines`; `reply` maps the lines to their answer."""
    calls = []

    async def _run(lines, title="", channel=""):
        calls.append(list(lines))
        return reply(lines)

    monkeypatch.setattr(feed, "_translate_lines", _run)
    return calls


async def translate(client):
    r = await client.get("/api/feed/captions-translate/vid1?at=0&count=3")
    return [(s["start"], s["text"]) for s in r.json()["sentences"]]


async def stored(db):
    db.expire_all()
    return await db.get(CaptionTranslation, ("vid1", "en", "zh-Hant"))


async def test_a_translation_is_kept_against_its_sentence(client, db, captions, monkeypatch):
    translator(monkeypatch, lambda lines: [f"zh {t}" for t in lines])
    assert await translate(client) == [(0.0, "zh One."), (2.0, "zh Two."), (4.0, "zh Three.")]
    row = await stored(db)
    assert json.loads(row.by_source) == {"One.": "zh One.", "Two.": "zh Two.", "Three.": "zh Three."}


async def test_a_line_the_model_didnt_return_is_shown_but_not_kept(client, db, captions, monkeypatch):
    """Kept, the source stood in for the translation for good — and the next
    request had no reason to ask again."""
    calls = translator(monkeypatch, lambda lines: [None if t == "Two." else f"zh {t}" for t in lines])
    assert await translate(client) == [(0.0, "zh One."), (2.0, "Two."), (4.0, "zh Three.")]
    assert "Two." not in json.loads((await stored(db)).by_source)

    await translate(client)
    assert calls[-1] == ["Two."]


async def test_a_row_keyed_by_position_is_read_by_its_sentences(client, db, captions, monkeypatch):
    db.add(CaptionTranslation(
        video_id="vid1", src_lang="en", target_lang="zh-Hant",
        lines=json.dumps({"0": "zh One.", "1": "zh Two.", "2": "zh Three."}),
    ))
    await db.commit()
    calls = translator(monkeypatch, lambda lines: pytest.fail("translated again"))
    assert await translate(client) == [(0.0, "zh One."), (2.0, "zh Two."), (4.0, "zh Three.")]
    assert calls == []


async def test_a_row_keyed_by_position_with_a_source_line_is_dropped(client, db, captions, monkeypatch):
    """A source line in an old row is a reply that came back short, most often
    one where every line after a join is a sentence late."""
    db.add(CaptionTranslation(
        video_id="vid1", src_lang="en", target_lang="zh-Hant",
        lines=json.dumps({"0": "zh One.", "1": "zh Three.", "2": "Three."}),
    ))
    await db.commit()
    calls = translator(monkeypatch, lambda lines: [f"zh {t}" for t in lines])
    assert await translate(client) == [(0.0, "zh One."), (2.0, "zh Two."), (4.0, "zh Three.")]
    assert calls == [["One.", "Two.", "Three."]]
