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


# ── matching_video_ids itself ────────────────────────────────────────
#
# Everything above stubs it out to see which rows survive. These few go the
# other way and stub Meilisearch instead, because this helper is the whole of
# what the feature asks the index for — and, being best-effort, it is also
# where a search degrades to "no results" rather than taking the page down.


@pytest.fixture
def meili(monkeypatch):
    """Stand in for the index itself: records each request body, answers with
    whatever hits the test lines up."""
    calls = []
    reply: dict = {"hits": []}

    async def fake(index, q, limit, offset=0, filter=None):
        calls.append({"index": index, "q": q, "limit": limit,
                      "offset": offset, "filter": filter})
        if isinstance(reply.get("raise"), Exception):
            raise reply["raise"]
        return reply

    monkeypatch.setattr(search_index, "_search_raw", fake)
    return {"calls": calls, "reply": reply}


async def test_a_blank_query_asks_the_index_nothing(meili):
    assert await search_index.matching_video_ids("   ", "chan1") == []
    assert meili["calls"] == []


async def test_the_query_is_confined_to_the_one_channel(meili):
    meili["reply"]["hits"] = [{"youtube_id": "v1"}, {"youtube_id": "v2"}]
    assert await search_index.matching_video_ids("pasta", "chan1") == ["v1", "v2"]
    call = meili["calls"][0]
    assert call["q"] == "pasta"
    assert call["filter"] == 'channel_id IN ["chan1"]'
    # The cap is the limit, and it bounds the id list a SQL `IN` is handed.
    assert call["limit"] == 500
    assert await search_index.matching_video_ids("pasta", "chan1", cap=5) == ["v1", "v2"]
    assert meili["calls"][1]["limit"] == 5


async def test_a_hit_with_no_id_is_no_use_to_a_where_clause(meili):
    meili["reply"]["hits"] = [{"youtube_id": "v1"}, {"title": "orphan"},
                              {"youtube_id": ""}]
    assert await search_index.matching_video_ids("pasta", "chan1") == ["v1"]


async def test_an_index_that_is_down_is_no_results_not_an_error(meili):
    """The caller turns this list into a WHERE clause, so an empty one is an
    empty page — never the unfiltered one, and never a 500."""
    meili["reply"]["raise"] = RuntimeError("connection refused")
    assert await search_index.matching_video_ids("pasta", "chan1") == []
