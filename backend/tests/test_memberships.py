"""Following a channel — and what happens to the catalog when you stop.

The change this pins down: unsubscribing used to delete the channel and every
video under it. With two people holding one shared catalog, that would be one
person deleting the other's feed.
"""

from datetime import datetime

import pytest
from sqlalchemy import func, select

from app import users
from app.models import Channel, User, UserChannel, Video
from app.routers.subscriptions import _prune_channels

pytestmark = pytest.mark.no_seeded_user


async def _two_people(db):
    me = await users.ensure_local_user(db)
    them = User(google_sub="sub-2", email="them@example.test",
                api_key=users.new_api_key())
    db.add(them)
    await db.commit()
    return me, them


async def _channel(db, channel_id="chanA", videos=2):
    db.add(Channel(youtube_id=channel_id, title="A Channel"))
    for i in range(videos):
        db.add(Video(youtube_id=f"{channel_id}-v{i}", channel_id=channel_id,
                     title=f"Video {i}", published_at=datetime(2026, 1, 2)))
    await db.commit()


# ── Holding and releasing ────────────────────────────────────────────


async def test_following_twice_is_one_membership(db):
    me = await users.ensure_local_user(db)
    await _channel(db)
    await users.hold(db, me, "chanA")
    await users.hold(db, me, "chanA")
    await db.commit()
    assert await users.held_channel_ids(db, me) == {"chanA"}


async def test_subscribing_to_a_hand_added_channel_makes_it_a_subscription(db):
    """It's in the live list now, so the resync exemption should stop applying —
    otherwise a channel could never be pruned once you'd ever added it by hand."""
    me = await users.ensure_local_user(db)
    await _channel(db)
    await users.hold(db, me, "chanA", source="manual")
    await users.hold(db, me, "chanA", source="subscription")
    await db.commit()

    row = await db.get(UserChannel, (me.id, "chanA"))
    assert row.source == "subscription"


async def test_two_people_can_follow_the_same_channel(db):
    """The point of a shared catalog: one row, one fetch, one tagging bill."""
    me, them = await _two_people(db)
    await _channel(db)
    await users.hold(db, me, "chanA")
    await users.hold(db, them, "chanA")
    await db.commit()

    assert await users.held_channel_ids(db, me) == {"chanA"}
    assert await users.held_channel_ids(db, them) == {"chanA"}
    assert (await db.execute(select(func.count()).select_from(Channel))).scalar_one() == 1


async def test_a_channel_someone_still_follows_is_not_an_orphan(db):
    me, them = await _two_people(db)
    await _channel(db)
    await users.hold(db, me, "chanA")
    await users.hold(db, them, "chanA")
    await db.commit()

    await users.release(db, me, ["chanA"])
    await db.commit()
    assert await users.orphaned_channel_ids(db, ["chanA"]) == []


async def test_the_last_person_to_let_go_orphans_it(db):
    me, them = await _two_people(db)
    await _channel(db)
    await users.hold(db, me, "chanA")
    await users.hold(db, them, "chanA")
    await db.commit()

    await users.release(db, me, ["chanA"])
    await users.release(db, them, ["chanA"])
    await db.commit()
    assert await users.orphaned_channel_ids(db, ["chanA"]) == ["chanA"]


# ── The prune, which is the destructive part ─────────────────────────


async def test_unfollowing_leaves_a_channel_someone_else_holds(db):
    """The whole reason the prune had to change. Before this, my resync would
    have deleted their channel and every video under it."""
    me, them = await _two_people(db)
    await _channel(db, videos=3)
    await users.hold(db, me, "chanA")
    await users.hold(db, them, "chanA")
    await db.commit()

    result = await _prune_channels(db, me, ["chanA"])

    assert result["released"] == 1
    assert result["channels"] == []
    assert result["videos"] == 0
    assert await db.get(Channel, "chanA") is not None
    assert (await db.execute(select(func.count()).select_from(Video))).scalar_one() == 3
    assert await users.held_channel_ids(db, them) == {"chanA"}


async def test_it_is_gone_from_my_list_all_the_same(db):
    me, them = await _two_people(db)
    await _channel(db)
    await users.hold(db, me, "chanA")
    await users.hold(db, them, "chanA")
    await db.commit()

    await _prune_channels(db, me, ["chanA"])
    assert await users.held_channel_ids(db, me) == set()


async def test_the_last_holder_leaving_deletes_the_catalog(db):
    """Still destructive when it should be — a channel nobody follows is dead
    weight, and this is the path that reclaims it."""
    me = await users.ensure_local_user(db)
    await _channel(db, videos=3)
    await users.hold(db, me, "chanA")
    await db.commit()

    result = await _prune_channels(db, me, ["chanA"])

    assert result["channels"] == ["chanA"]
    assert result["videos"] == 3
    assert await db.get(Channel, "chanA") is None
    assert (await db.execute(select(func.count()).select_from(Video))).scalar_one() == 0


async def test_pruning_nothing_deletes_nothing(db):
    me = await users.ensure_local_user(db)
    await _channel(db)
    await users.hold(db, me, "chanA")
    await db.commit()

    result = await _prune_channels(db, me, [])
    assert result == {"channels": [], "videos": 0, "released": 0}
    assert await db.get(Channel, "chanA") is not None


async def test_one_persons_channels_are_out_of_the_others_scope(db):
    """Nothing stops a prune list naming a channel you don't hold — so releasing
    a membership that isn't yours must be a no-op, not a deletion."""
    me, them = await _two_people(db)
    await _channel(db, "theirs")
    await users.hold(db, them, "theirs")
    await db.commit()

    result = await _prune_channels(db, me, ["theirs"])

    assert result["released"] == 0
    assert result["channels"] == []
    assert await db.get(Channel, "theirs") is not None


# ── Through the API ──────────────────────────────────────────────────


async def test_the_subscription_list_is_what_you_hold(client, db):
    me = await users.ensure_local_user(db)
    await _channel(db, "chanA")
    await _channel(db, "chanB")
    await users.hold(db, me, "chanA")
    await db.commit()

    assert (await client.get("/api/subscriptions")).json() == ["chanA"]


async def test_an_anonymous_browser_on_a_one_account_box_is_that_account(client, db):
    """`user_or_sole` — the app has no sign-in screen yet, and the person using
    it is plainly the only account on the machine."""
    me = await users.ensure_local_user(db)
    await _channel(db)
    await users.hold(db, me, "chanA")
    await db.commit()

    assert (await client.get("/api/subscriptions")).json() == ["chanA"]


async def test_the_guess_stops_once_a_second_account_exists(client, db):
    """Two accounts make "you must be the only one" false, and answering with
    somebody's list would be picking one at random — so it asks who you are."""
    await _two_people(db)
    r = await client.get("/api/subscriptions")
    assert r.status_code == 401


async def test_an_api_key_names_its_owner(client, db):
    me, them = await _two_people(db)
    await _channel(db, "mine")
    await _channel(db, "theirs")
    await users.hold(db, me, "mine")
    await users.hold(db, them, "theirs")
    await db.commit()

    r = await client.get(
        "/api/subscriptions", headers={"Authorization": f"Bearer {them.api_key}"}
    )
    assert r.json() == ["theirs"]
