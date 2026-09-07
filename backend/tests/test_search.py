"""Searching inside one channel.

The channel page does its own windowing, ranking and paging; searching within it
only adds "and the title matches". Meilisearch is stubbed — the suite has no
business starting an index, and what matters here is which rows survive.
"""

from datetime import datetime, timedelta

import pytest

from app import search_index, users
from app.models import Channel, Video

pytestmark = pytest.mark.asyncio


@pytest.fixture
def matches(monkeypatch):
    """Stand in for Meilisearch: hands back whatever ids the test lines up, and
    records the (query, channel) each request asked about."""
    asked = []
    hits: list[str] = []

    async def fake(q, channel_id, cap=500):
        asked.append((q, channel_id))
        return list(hits)

    monkeypatch.setattr(search_index, "matching_video_ids", fake)
    return {"asked": asked, "hits": hits}


@pytest.fixture
async def channel(db, seeded_user):
    """One channel with three videos, a month apart."""
    db.add(Channel(youtube_id="chan1", title="Cooking"))
    now = datetime.utcnow()
    for i, (vid, title, days) in enumerate((
        ("v1", "Pasta tonight", 1),
        ("v2", "Pasta again", 40),
        ("v3", "Soup", 2),
    )):
        db.add(Video(
            youtube_id=vid, channel_id="chan1", title=title,
            published_at=now - timedelta(days=days),
            view_count=100 * (i + 1), like_count=10, duration_seconds=600,
            is_short=False,
        ))
    await users.hold(db, seeded_user, "chan1")
    await db.commit()


async def _titles(client, query=""):
    r = await client.get(f"/api/channels/chan1/videos?age=0-all{query}")
    assert r.status_code == 200
    d = r.json()
    return [v["title"] for v in d["videos"]], d["total"]


async def test_without_a_query_the_page_is_unfiltered(client, channel, matches):
    titles, total = await _titles(client)
    assert total == 3
    assert matches["asked"] == []


async def test_a_query_keeps_only_the_matching_videos(client, channel, matches):
    matches["hits"] += ["v1", "v2"]
    titles, total = await _titles(client, "&q=pasta")
    assert sorted(titles) == ["Pasta again", "Pasta tonight"]
    assert total == 2
    assert matches["asked"] == [("pasta", "chan1")]


async def test_the_window_still_applies_inside_a_search(client, channel, matches):
    """The point of the whole exercise: a scoped search is the channel page with
    one more filter on it, not a separate ranking that ignores the bar."""
    matches["hits"] += ["v1", "v2"]
    r = await client.get("/api/channels/chan1/videos?age=0-7&q=pasta")
    d = r.json()
    assert [v["title"] for v in d["videos"]] == ["Pasta tonight"]
    assert d["total"] == 1


async def test_the_sort_still_applies_inside_a_search(client, channel, matches):
    matches["hits"] += ["v1", "v2", "v3"]
    for sort, first in (("newest", "Pasta tonight"), ("oldest", "Pasta again")):
        r = await client.get(f"/api/channels/chan1/videos?age=0-all&sort={sort}&q=x")
        assert r.json()["videos"][0]["title"] == first


async def test_nothing_matching_is_an_empty_page_not_an_unfiltered_one(
    client, channel, matches
):
    """Also what a Meilisearch that isn't running looks like from here."""
    titles, total = await _titles(client, "&q=nothing like this")
    assert titles == []
    assert total == 0


async def test_relevance_keeps_the_order_meilisearch_handed_back(client, channel, matches):
    """The one ordering the DB can't produce — it's about the words, not the
    numbers — so it has to survive the ranking pass untouched."""
    matches["hits"] += ["v3", "v1", "v2"]
    r = await client.get("/api/channels/chan1/videos?age=0-all&sort=relevance&q=x")
    assert [v["title"] for v in r.json()["videos"]] == [
        "Soup", "Pasta tonight", "Pasta again",
    ]


async def test_relevance_still_obeys_the_window(client, channel, matches):
    matches["hits"] += ["v2", "v1"]
    r = await client.get("/api/channels/chan1/videos?age=0-7&sort=relevance&q=pasta")
    assert [v["title"] for v in r.json()["videos"]] == ["Pasta tonight"]


async def test_relevance_without_a_query_falls_back_to_the_page_default(
    client, channel, matches
):
    """Nothing to be relevant to. Left alone it would read as an unknown sort
    and quietly become "hot", which is a different list than the bar claims."""
    r = await client.get("/api/channels/chan1/videos?age=0-all&sort=relevance")
    d = r.json()
    assert d["sort"] == "likes"
    assert d["total"] == 3
