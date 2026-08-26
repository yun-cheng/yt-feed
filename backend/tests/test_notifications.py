"""The bell — rows that outlive the tab that would have shown a toast."""

import pytest

from app import users
from app.models import Notification, User


async def add(db, user_id, **kw):
    n = Notification(user_id=user_id, kind="summary", title="Summary ready", **kw)
    db.add(n)
    await db.commit()
    return n


async def test_an_empty_bell_is_empty_rather_than_missing(client):
    assert (await client.get("/api/notifications")).json() == {"notifications": [], "unread": 0}


async def test_newest_first(client, db, seeded_user):
    await add(db, seeded_user.id, body="first")
    await add(db, seeded_user.id, body="second")
    rows = (await client.get("/api/notifications")).json()["notifications"]
    assert [r["body"] for r in rows] == ["second", "first"]


async def test_new_notifications_start_unread(client, db, seeded_user):
    await add(db, seeded_user.id, body="first")
    assert (await client.get("/api/notifications")).json()["unread"] == 1


async def test_opening_the_bell_reads_all_of_them(client, db, seeded_user):
    """The badge means "new since you looked", and looking is the whole
    interaction — there is nothing else to do with a row but read it."""
    await add(db, seeded_user.id, body="first")
    await add(db, seeded_user.id, body="second")

    assert (await client.post("/api/notifications/read")).status_code == 200
    data = (await client.get("/api/notifications")).json()
    assert data["unread"] == 0
    assert all(n["read"] for n in data["notifications"])


async def test_one_can_be_read_on_its_own(client, db, seeded_user):
    n = await add(db, seeded_user.id, body="first")
    await add(db, seeded_user.id, body="second")
    await client.post(f"/api/notifications/{n.id}/read")
    assert (await client.get("/api/notifications")).json()["unread"] == 1


async def test_a_row_about_no_video_carries_no_cover(client, db, seeded_user):
    """The generic shape has to survive a kind that isn't about a video — the
    bell falls back to the kind's icon."""
    await add(db, seeded_user.id, body="something else")
    n = (await client.get("/api/notifications")).json()["notifications"][0]
    assert n["video_id"] == "" and n["thumbnail_url"] == ""


async def test_dismissing_removes_it(client, db, seeded_user):
    n = await add(db, seeded_user.id, body="first")
    assert (await client.delete(f"/api/notifications/{n.id}")).status_code == 200
    assert (await client.get("/api/notifications")).json()["notifications"] == []


async def test_clear_all_empties_the_bell(client, db, seeded_user):
    await add(db, seeded_user.id, body="first")
    await add(db, seeded_user.id, body="second")
    await client.delete("/api/notifications")
    assert (await client.get("/api/notifications")).json() == {"notifications": [], "unread": 0}


@pytest.mark.no_seeded_user
async def test_you_cannot_read_or_dismiss_someone_else_s(client, db):
    me = await users.ensure_local_user(db)
    them = User(google_sub="sub-2", email="them@example.test", api_key=users.new_api_key())
    db.add(them)
    await db.commit()
    n = await add(db, me.id, body="mine")
    mine = {"Authorization": f"Bearer {me.api_key}"}
    theirs = {"Authorization": f"Bearer {them.api_key}"}

    assert (await client.get("/api/notifications", headers=theirs)).json()["unread"] == 0
    assert (await client.post(f"/api/notifications/{n.id}/read", headers=theirs)).status_code == 404
    assert (await client.delete(f"/api/notifications/{n.id}", headers=theirs)).status_code == 404
    await client.delete("/api/notifications", headers=theirs)
    assert (await client.get("/api/notifications", headers=mine)).json()["unread"] == 1
