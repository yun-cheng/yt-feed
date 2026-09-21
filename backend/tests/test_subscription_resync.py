"""The resync prune — the one endpoint that deletes things you didn't ask it to.

`POST /api/subscriptions/resync` reconciles the channels you hold against the
live YouTube subscription list, and whatever isn't in that list it *deletes*:
the membership, and then the channel and every video of it if nobody else holds
it. Everything else in the app removes one named thing; this removes whatever a
remote API failed to mention.

So the interesting tests here are the refusals, not the happy path — the guards
that stand between an API hiccup and an empty feed, plus the dry run that lets
you look before running it at all. Ownership is the one guard tested elsewhere
(test_people.py), because it's about accounts rather than about deleting.

One happy-path test is in here on purpose: without it, every refusal above
would still pass if the prune had quietly stopped pruning.
"""

from datetime import datetime, timezone

import pytest

from app import users
from app.models import Channel, Video


@pytest.fixture
def live(monkeypatch):
    """Stand in for the live subscription list, and never write the real file."""
    from app.routers import subscriptions as subs_mod

    monkeypatch.setattr(subs_mod, "_write_subscriptions", lambda ids: None)

    async def _sync_all(user, db):
        return {}

    monkeypatch.setattr(subs_mod, "sync_all_from_subscriptions", _sync_all)

    def _set(*channel_ids, raises=None):
        async def _fetch():
            if raises is not None:
                raise raises
            return {"channels": [{"youtube_id": c} for c in channel_ids]}

        monkeypatch.setattr("app.auth_google.fetch_subscriptions", _fetch)

    return _set


async def _following(db, user, *channels):
    """Hold these channels, each with a video, as a real feed would."""
    for cid, source in channels:
        db.add(Channel(youtube_id=cid, title=f"Channel {cid}"))
        db.add(Video(
            youtube_id=f"v-{cid}",
            channel_id=cid,
            title=f"A video from {cid}",
            published_at=datetime.now(timezone.utc),
        ))
        await users.hold(db, user, cid, source=source)
    await db.commit()


# ── The guard against an empty answer ────────────────────────────────


async def test_an_empty_live_list_is_refused_rather_than_obeyed(client, db, live):
    """The failure this exists for: YouTube answers 200 with nothing in it.

    Taken at face value that reads as "you are subscribed to nothing", and the
    prune would then delete every channel and every video in the app. There is
    no undo — the videos are gone and the next scan re-fetches them from zero.
    """
    me = await users.ensure_local_user(db)
    await _following(db, me, ("chanA", "subscription"), ("chanB", "subscription"))
    live()  # a 200 with an empty `channels` list

    r = await client.post("/api/subscriptions/resync")

    assert r.status_code == 400
    assert "refusing to prune" in r.text
    # And nothing was touched on the way to refusing.
    assert set(await users.held_channel_ids(db, me)) == {"chanA", "chanB"}


async def test_expired_auth_is_refused_rather_than_read_as_an_empty_list(client, db, live):
    """A dead token raises instead of returning [], and must not reach the prune
    either — same wipe by a different road."""
    from google.auth.exceptions import GoogleAuthError

    me = await users.ensure_local_user(db)
    await _following(db, me, ("chanA", "subscription"))
    live(raises=GoogleAuthError("token expired"))

    r = await client.post("/api/subscriptions/resync")

    assert r.status_code == 401
    assert set(await users.held_channel_ids(db, me)) == {"chanA"}


# ── The channels you added by hand ───────────────────────────────────


async def test_a_hand_added_channel_survives_a_resync_that_never_mentions_it(
    client, db, live
):
    """A manual channel is not a subscription and will never be in the live
    list, so "absent from the live list" cannot mean "delete it" — otherwise
    adding a channel and syncing would silently undo the add."""
    me = await users.ensure_local_user(db)
    await _following(db, me, ("byhand", "manual"), ("subbed", "subscription"))
    live("subbed")

    r = await client.post("/api/subscriptions/resync")

    assert r.status_code == 200, r.text
    assert set(await users.held_channel_ids(db, me)) == {"byhand", "subbed"}
    assert await db.get(Channel, "byhand") is not None


async def test_a_subscription_youtube_has_dropped_is_pruned_with_its_videos(
    client, db, live
):
    """The other half: this endpoint does delete, and the tests above are about
    when it must not — not about it having stopped working."""
    me = await users.ensure_local_user(db)
    await _following(db, me, ("kept", "subscription"), ("dropped", "subscription"))
    live("kept")

    r = await client.post("/api/subscriptions/resync")

    assert r.status_code == 200, r.text
    assert set(await users.held_channel_ids(db, me)) == {"kept"}
    assert await db.get(Channel, "dropped") is None
    assert await db.get(Video, "v-dropped") is None
    assert await db.get(Video, "v-kept") is not None


# ── Looking before it leaps ──────────────────────────────────────────


async def test_dry_run_reports_the_damage_without_doing_any_of_it(client, db, live):
    """The preview is what makes the prune safe to run at all — and a preview
    that quietly deleted would be worse than no preview."""
    me = await users.ensure_local_user(db)
    await _following(db, me, ("kept", "subscription"), ("doomed", "subscription"))
    live("kept")

    r = await client.post("/api/subscriptions/resync?dry_run=true")

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dry_run"] is True
    assert [c["youtube_id"] for c in body["would_prune_channels"]] == ["doomed"]
    assert body["would_delete_videos"] == 1
    # Counted, not deleted.
    assert await db.get(Channel, "doomed") is not None
    assert await db.get(Video, "v-doomed") is not None
    assert set(await users.held_channel_ids(db, me)) == {"doomed", "kept"}


async def test_dry_run_leaves_a_hand_added_channel_out_of_the_damage_report(
    client, db, live
):
    """The preview has to apply the same exemption the prune does, or it warns
    about a deletion that would never happen and reads as a reason not to run."""
    me = await users.ensure_local_user(db)
    await _following(db, me, ("byhand", "manual"), ("subbed", "subscription"))
    live("subbed")

    body = (await client.post("/api/subscriptions/resync?dry_run=true")).json()

    assert body["would_prune_channels"] == []
    assert body["would_delete_videos"] == 0
