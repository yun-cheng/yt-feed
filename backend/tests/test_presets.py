"""Saved filter presets — a sidebar selection, named and put back on later.

The endpoint is a store rather than a filter: nothing here interprets the blob.
What it does own is the name — unique per user, so saving twice under one name
is an overwrite rather than two chips you can't tell apart — and the shape, so a
typo'd key is a 400 instead of a preset that silently filters nothing.
"""

import pytest

from app import users
from app.models import FilterPreset, User


async def save(client, name, **filters):
    r = await client.post("/api/presets", json={"name": name, "filters": filters})
    assert r.status_code == 200, r.text
    return r.json()


async def listed(client, headers=None):
    r = await client.get("/api/presets", headers=headers or {})
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_saved_preset_comes_back_whole(client):
    made = await save(client, "Chinese, unwatched",
                      tags=["chinese", "-piano"], watch=["unwatched"], summarised=True)
    assert made["name"] == "Chinese, unwatched"
    assert made["filters"] == {
        "tags": ["chinese", "-piano"], "watch": ["unwatched"],
        "summarised": True, "shorts": False, "hidden": False, "length": None,
    }
    assert await listed(client) == [made]


async def test_nothing_saved_is_an_empty_list_not_a_404(client):
    assert await listed(client) == []


async def test_defaults_fill_in_what_the_sidebar_did_not_send(client):
    """A preset about tags alone leaves `watch` null — "don't touch it" — rather
    than an empty list, which would mean "clear the watch filter"."""
    made = await save(client, "Just tags", tags=["piano"])
    assert made["filters"]["watch"] is None
    assert made["filters"]["summarised"] is False


async def test_saving_under_an_existing_name_overwrites_it(client):
    first = await save(client, "Evening", tags=["music"])
    again = await save(client, "Evening", tags=["gaming"], shorts=True)
    assert again["id"] == first["id"]
    rows = await listed(client)
    assert len(rows) == 1
    assert rows[0]["filters"]["tags"] == ["gaming"]
    assert rows[0]["filters"]["shorts"] is True


async def test_a_name_is_trimmed_and_a_blank_one_refused(client):
    assert (await save(client, "  Morning  "))["name"] == "Morning"
    assert (await client.post("/api/presets", json={"name": "   "})).status_code == 400


async def test_an_unknown_filter_key_is_refused(client):
    r = await client.post("/api/presets",
                          json={"name": "Typo", "filters": {"tag": ["chinese"]}})
    assert r.status_code == 422


async def test_deleting_one_leaves_the_rest(client):
    a = await save(client, "A")
    await save(client, "B")
    assert (await client.delete(f"/api/presets/{a['id']}")).status_code == 200
    assert [p["name"] for p in await listed(client)] == ["B"]
    assert (await client.delete(f"/api/presets/{a['id']}")).status_code == 404


@pytest.mark.no_seeded_user
async def test_presets_are_yours_alone(client, db):
    me = await users.ensure_local_user(db)
    them = User(google_sub="sub-2", email="them@example.test", api_key=users.new_api_key())
    db.add(them)
    await db.commit()
    mine = {"Authorization": f"Bearer {me.api_key}"}
    theirs = {"Authorization": f"Bearer {them.api_key}"}

    r = await client.post("/api/presets", json={"name": "Mine", "filters": {"tags": ["chinese"]}},
                          headers=mine)
    made = r.json()
    assert await listed(client, theirs) == []
    assert (await client.delete(f"/api/presets/{made['id']}", headers=theirs)).status_code == 404
    # And the same name is free for both of them.
    assert (await client.post("/api/presets", json={"name": "Mine"}, headers=theirs)).status_code == 200
    assert [p["name"] for p in await listed(client, mine)] == ["Mine"]


async def test_a_very_long_name_is_cut_rather_than_refused(client):
    """The chip has a row to live on. Sixty characters is already more than one
    holds, and a name that long is a slip rather than a request."""
    made = await save(client, "x" * 200)
    assert made["name"] == "x" * 60


async def test_they_come_back_in_the_order_they_were_made(client):
    for name in ("First", "Second", "Third"):
        await save(client, name)
    assert [p["name"] for p in await listed(client)] == ["First", "Second", "Third"]


async def test_a_blob_that_will_not_parse_filters_nothing(client, db):
    """One unreadable row shouldn't take the whole sidebar down with it — the
    preset is still there to be clicked, it just asks for nothing."""
    made = await save(client, "Broken", tags=["chinese"])
    row = await db.get(FilterPreset, made["id"])
    row.filters = "{not json"
    await db.commit()
    listing = await listed(client)
    assert [p["name"] for p in listing] == ["Broken"]
    assert listing[0]["filters"] == {
        "tags": [], "watch": None, "summarised": False, "shorts": False, "hidden": False,
        "length": None,
    }
