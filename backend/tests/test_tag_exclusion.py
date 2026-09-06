"""Tags you select AGAINST — `-chinese` for "everything but Chinese".

The sidebar's tag chips cycle off → for → against, and the against half is
spelled with a leading hyphen in the same comma-separated `tags=` both these
endpoints already took. Only the first character is the marker: real tag names
contain hyphens (film-tv, real-estate) and none of them start with one.

The rule worth pinning down is that an exclusion is a FLAT veto. Inclusions are
OR within a tag group and AND across groups; folding exclusions into that would
make a second crossed-out language mean "not Chinese OR not Japanese", which is
true of every channel there is.
"""

import datetime

import pytest

from app import users
from app.models import Channel, ChannelTag, Video, User


@pytest.fixture
async def library(db):
    """Three channels: a Chinese piano one, an English piano one, and neither.

    Published now, so the feed's default window can't be what excludes anything.
    """
    user = await db.get(User, 1)
    tagged = {"cn": ["chinese", "piano"], "en": ["english", "piano"], "misc": []}
    for cid, names in tagged.items():
        db.add(Channel(youtube_id=cid, title=f"Channel {cid}"))
        db.add(Video(youtube_id=f"v-{cid}", channel_id=cid, title=f"Video {cid}",
                     published_at=datetime.datetime.utcnow(), view_count=100))
        for name in names:
            db.add(ChannelTag(user_id=user.id, channel_id=cid, tag_name=name))
    await db.commit()
    for cid in tagged:
        await users.hold(db, user, cid)
    await db.commit()


async def feed(client, tags):
    r = await client.get(f"/api/tags/feed?tags={tags}")
    assert r.status_code == 200, r.text
    return r.json()


def ids(payload):
    return sorted(v["youtube_id"] for v in payload["videos"])


async def test_an_exclusion_on_its_own_means_everything_but_that(client, library):
    """Not an empty feed: with nothing selected FOR there is no positive
    constraint to intersect against, only a veto to apply."""
    assert ids(await feed(client, "-chinese")) == ["v-en", "v-misc"]


async def test_an_exclusion_narrows_an_inclusion(client, library):
    assert ids(await feed(client, "piano,-chinese")) == ["v-en"]


async def test_two_exclusions_are_and_not_or(client, library):
    """Read as part of the OR-within-a-group rule these would cancel out, since
    every channel is "not Chinese or not English"."""
    assert ids(await feed(client, "-chinese,-english")) == ["v-misc"]


async def test_an_exclusion_beats_an_inclusion_that_would_have_kept_it(client, library):
    assert ids(await feed(client, "piano,-chinese,-english")) == []


async def test_the_response_says_which_way_each_tag_went(client, library):
    body = await feed(client, "piano,-chinese")
    assert body["tags"] == ["piano"]
    assert body["excluded_tags"] == ["chinese"]


async def test_nothing_changes_when_nothing_is_crossed_out(client, library):
    assert ids(await feed(client, "piano")) == ["v-cn", "v-en"]
    assert ids(await feed(client, "")) == ["v-cn", "v-en", "v-misc"]


async def test_the_channels_list_excludes_the_same_way(client, library):
    """One sidebar selection, two endpoints — the Channels page reads the same
    `tags=` string the feed does."""
    async def names(tags):
        r = await client.get(f"/api/channels?tags={tags}")
        return sorted(c["youtube_id"] for c in r.json())

    assert await names("") == ["cn", "en", "misc"]
    assert await names("-chinese") == ["en", "misc"]
    assert await names("piano,-chinese") == ["en"]


async def test_a_bare_hyphen_is_not_an_exclusion_of_nothing(client, library):
    """`-` alone would otherwise become an empty tag name and match nothing —
    or, worse, everything."""
    assert ids(await feed(client, "-")) == ["v-cn", "v-en", "v-misc"]
