"""A video's chapters, as the watch page gets them.

yt-dlp reads the description's timestamp list and hands back `chapters`; what's
pinned here is the trip from there to the bar: the shape, what's dropped, and
that the description endpoint carries them whichever path warmed the cache.
"""

import pytest

from app.routers import feed
from app.routers.feed import _chapters_from_info


def ch(start, end, title="x"):
    return {"start_time": start, "end_time": end, "title": title}


def test_chapters_come_back_in_seconds_with_their_titles():
    assert _chapters_from_info({"chapters": [ch(0, 115, "開場"), ch(115, 192, "模型")]}) == [
        {"start": 0.0, "end": 115.0, "title": "開場"},
        {"start": 115.0, "end": 192.0, "title": "模型"},
    ]


def test_a_video_without_chapters_has_none():
    assert _chapters_from_info({"chapters": None}) == []
    assert _chapters_from_info({}) == []


def test_malformed_entries_are_dropped_rather_than_drawn():
    assert _chapters_from_info({"chapters": [
        ch(0, 10, "ok"), ch(10, 10, "empty"), {"title": "no times"}, ch("x", 20),
    ]}) == [{"start": 0.0, "end": 10.0, "title": "ok"}]


@pytest.fixture
def fake_extraction(monkeypatch):
    calls: list[str] = []

    def fake(video_id):
        calls.append(video_id)
        return {"description": "0:00 a\n1:00 b", "chapters": [ch(0, 60, "a"), ch(60, 90, "b")],
                "formats": []}

    monkeypatch.setattr(feed, "_extract_info", fake)
    feed._desc_cache.clear()
    feed._desc_inflight.clear()
    return calls


@pytest.mark.asyncio
async def test_the_description_endpoint_carries_the_chapters(client, fake_extraction):
    r = await client.get("/api/feed/description/vid1")
    assert r.json() == {
        "description": "0:00 a\n1:00 b",
        "chapters": [{"start": 0.0, "end": 60.0, "title": "a"},
                     {"start": 60.0, "end": 90.0, "title": "b"}],
    }


@pytest.mark.asyncio
async def test_a_hover_warms_the_chapters_too(client, fake_extraction):
    """The storyboard fetch a card hover makes is the same extraction, so the
    watch page that follows mustn't need another."""
    await feed._fetch_storyboard("vid1")
    r = await client.get("/api/feed/description/vid1")
    assert [c["title"] for c in r.json()["chapters"]] == ["a", "b"]
    assert fake_extraction == ["vid1"]


@pytest.mark.asyncio
async def test_a_failed_extraction_reads_as_empty(client, monkeypatch):
    def boom(video_id):
        raise RuntimeError("blocked")

    monkeypatch.setattr(feed, "_extract_info", boom)
    feed._desc_cache.clear()
    r = await client.get("/api/feed/description/vid1")
    assert r.json() == {"description": "", "chapters": []}
