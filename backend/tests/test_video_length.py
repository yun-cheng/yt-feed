"""Filtering a list by how long the videos are.

The bucket table lives in routers/tags.py and the sidebar has its own copy
(VIDEO_LENGTHS in App.tsx), so what's pinned here is the part both sides have to
agree on: where the boundaries fall, what an empty selection means, and what
happens to a video whose runtime we never learned.
"""

import datetime

import pytest

from app.models import Channel, User, Video
from app import users
from app.routers.tags import LENGTH_BUCKETS, wanted_lengths


def ids(payload):
    return {v["youtube_id"] for v in payload["videos"]}


@pytest.fixture
async def a_library(db):
    """One followed channel and a video in each bucket, every boundary second,
    and one video of unknown length.

    Published now, so the feed's default window can't be what excludes anything.
    """
    db.add(Channel(youtube_id="chan1", title="A Channel"))
    runtimes = {
        "tiny": 30,          # under5
        "five": 5 * 60,      # the first second of 5to10, not the last of under5
        "eight": 8 * 60,     # 5to10
        "ten": 10 * 60,      # the first second of 10to20
        "fifteen": 15 * 60,  # 10to20
        "twenty": 20 * 60,   # the first second of over20
        "hour": 60 * 60,     # over20
        "unknown": 0,        # never probed
    }
    for vid, secs in runtimes.items():
        db.add(Video(youtube_id=vid, channel_id="chan1", title=f"Video {vid}",
                     published_at=datetime.datetime.utcnow(), view_count=100,
                     duration_seconds=secs))
    await db.commit()

    user = await db.get(User, 1)
    await users.hold(db, user, "chan1")
    await db.commit()


# ── what a selection means ───────────────────────────────────────────


def test_nothing_chosen_is_no_filter():
    assert wanted_lengths("") == set()


def test_every_bucket_chosen_is_also_no_filter():
    """Same rule the watch statuses follow: selecting the lot narrows nothing,
    so it's cheaper to say so than to build a WHERE that keeps everything."""
    assert wanted_lengths(",".join(LENGTH_BUCKETS)) == set()


def test_a_name_we_do_not_know_is_dropped_not_refused():
    """A stale link is worth less than a 422 — it should still show you a page.

    This is also what a MOVED boundary looks like: the old name retires with the
    old range, so a preset saved under it loses the filter out loud rather than
    quietly coming to mean a range nobody chose.
    """
    assert wanted_lengths("under5,gargantuan") == {"under5"}
    assert wanted_lengths("gargantuan") == set()


# ── the feed ─────────────────────────────────────────────────────────


async def test_the_feed_is_unfiltered_unless_asked(client, a_library):
    r = (await client.get("/api/tags/feed")).json()
    assert ids(r) == {"tiny", "five", "eight", "ten", "fifteen", "twenty", "hour", "unknown"}
    assert r["length"] == []


async def test_the_boundaries_belong_to_the_longer_bucket(client, a_library):
    """5:00 is the first second of "5-10", not the last of "under 5", and 10:00
    and 20:00 likewise open theirs. Half-open ranges, so no video is in two."""
    assert ids((await client.get("/api/tags/feed?length=under5")).json()) == {"tiny"}
    assert ids((await client.get("/api/tags/feed?length=5to10")).json()) == {"five", "eight"}
    assert ids((await client.get("/api/tags/feed?length=10to20")).json()) == {"ten", "fifteen"}
    assert ids((await client.get("/api/tags/feed?length=over20")).json()) == {"twenty", "hour"}


async def test_the_buckets_add_up_to_the_whole_shelf(client, a_library):
    """Two chips on is the union of the two, with nothing lost between them."""
    r = (await client.get("/api/tags/feed?length=under5,over20")).json()
    assert ids(r) == {"tiny", "twenty", "hour"}
    assert r["length"] == ["over20", "under5"]


async def test_a_video_of_unknown_length_is_in_no_bucket(client, a_library):
    """0 seconds means "never probed", not "under five minutes" — claiming
    otherwise would stuff every unprobed video into the shortest bucket."""
    for bucket in LENGTH_BUCKETS:
        assert "unknown" not in ids((await client.get(f"/api/tags/feed?length={bucket}")).json())
    # And it comes back the moment you stop filtering, which is the only honest
    # place for it.
    every = ",".join(LENGTH_BUCKETS)
    assert "unknown" in ids((await client.get(f"/api/tags/feed?length={every}")).json())


async def test_the_count_matches_what_you_are_shown(client, a_library):
    """Filtered before ranking and paging, like the watch and summary filters —
    a `total` counting videos that were then dropped promises pages that aren't
    there."""
    r = (await client.get("/api/tags/feed?length=5to10")).json()
    assert r["total"] == 2


# ── a channel page ───────────────────────────────────────────────────


async def test_a_channel_page_filters_the_same_way(client, a_library):
    r = (await client.get("/api/channels/chan1/videos?length=over20")).json()
    assert ids(r) == {"twenty", "hour"}
    assert r["total"] == 2
    assert (await client.get("/api/channels/chan1/videos")).json()["total"] == 8
