"""Filtering the Channels page by what's typed in the search box.

The page holds its whole list, so the matching happens here rather than in SQL:
plain name matching first, Meilisearch (stubbed, as everywhere in this suite)
for the typo-tolerant middle, topics last.
"""

import pytest

from app import search_index, users
from app.models import Channel, ChannelTag
from app.routers.channels import match_channels

pytestmark = pytest.mark.asyncio


@pytest.fixture
def fuzzy(monkeypatch):
    """Stand in for Meilisearch: hands back whatever ids the test lines up."""
    hits: list[str] | None = []
    asked: list[str] = []

    async def fake(q, channel_ids, cap=500):
        asked.append(q)
        return hits if hits is None else list(hits)

    monkeypatch.setattr(search_index, "matching_channel_ids", fake)
    state = {"asked": asked}

    def lineup(ids):
        nonlocal hits
        hits = ids

    state["lineup"] = lineup
    return state


@pytest.fixture
async def channels(db, seeded_user):
    """Four channels: two named for piano, one tagged for it, one neither."""
    for cid, title, subs in (
        ("c1", "Piano Lessons", 900),
        ("c2", "Late Night Piano", 500),
        ("c3", "marasy8", 300),
        ("c4", "Cooking", 100),
    ):
        db.add(Channel(youtube_id=cid, title=title, subscriber_count=subs))
        await users.hold(db, seeded_user, cid)
    db.add(ChannelTag(user_id=seeded_user.id, channel_id="c3", tag_name="Piano"))
    await db.commit()


async def _titles(client, query=""):
    r = await client.get(f"/api/channels{query}")
    assert r.status_code == 200
    return [c["title"] for c in r.json()]


async def test_without_a_query_the_page_is_the_whole_list(client, channels, fuzzy):
    assert await _titles(client) == [
        "Piano Lessons", "Late Night Piano", "marasy8", "Cooking",
    ]


async def test_a_query_keeps_the_names_and_the_topics_that_match(client, channels, fuzzy):
    assert await _titles(client, "?q=piano") == [
        "Piano Lessons", "Late Night Piano", "marasy8",
    ]


async def test_relevance_leads_with_the_name_that_starts_with_it(client, channels, fuzzy):
    # c2 holds "piano", c3 only wears it as a topic — and both come after the
    # channel actually called it.
    assert await _titles(client, "?q=piano&sort=relevance") == [
        "Piano Lessons", "Late Night Piano", "marasy8",
    ]


async def test_another_sort_keeps_the_pages_own_order(client, channels, fuzzy):
    assert await _titles(client, "?q=piano&sort=alpha") == [
        "Late Night Piano", "Piano Lessons", "marasy8",
    ]


async def test_a_typo_reaches_the_channel_through_meilisearch(client, channels, fuzzy):
    # "painu" matches no name and no topic by substring; the index says it means
    # c2, and that is the only reason the channel comes back at all.
    fuzzy["lineup"](["c2"])
    assert await _titles(client, "?q=painu") == ["Late Night Piano"]


async def test_a_dead_index_still_matches_what_it_plainly_can(client, channels, fuzzy):
    # None is "the index couldn't answer" — the page falls back to substrings
    # rather than going empty because a companion service is down.
    fuzzy["lineup"](None)
    assert await _titles(client, "?q=piano") == [
        "Piano Lessons", "Late Night Piano", "marasy8",
    ]


async def test_match_channels_ranks_the_fuzzy_hits_between_names_and_topics():
    rows = [
        {"youtube_id": "a", "title": "Jazz for Piano Players", "tags": []},
        {"youtube_id": "b", "title": "Pianoforte", "tags": []},
        {"youtube_id": "c", "title": "marasy8", "tags": ["Piano"]},
        {"youtube_id": "d", "title": "Panio Covers", "tags": []},
    ]
    got = [c["youtube_id"] for c in match_channels(rows, "piano", ["d"])]
    assert got == ["b", "a", "d", "c"]


async def test_match_channels_folds_case_and_width():
    rows = [{"youtube_id": "a", "title": "Fireship", "tags": []}]
    assert match_channels(rows, "ＦＩＲＥ", []) == rows
