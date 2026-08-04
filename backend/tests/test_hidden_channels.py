"""Hidden channels — hidden server-side so the feed query can exclude them
before they ever reach the client."""


async def test_starts_empty(client):
    assert (await client.get("/api/hidden-channels")).json() == {"channel_ids": []}


async def test_hide_then_list(client):
    r = await client.post("/api/hidden-channels/chan1")
    assert r.json() == {"channel_id": "chan1", "hidden": True}
    assert (await client.get("/api/hidden-channels")).json()["channel_ids"] == ["chan1"]


async def test_hiding_twice_is_idempotent(client):
    await client.post("/api/hidden-channels/chan1")
    await client.post("/api/hidden-channels/chan1")
    assert (await client.get("/api/hidden-channels")).json()["channel_ids"] == ["chan1"]


async def test_unhide(client):
    await client.post("/api/hidden-channels/chan1")
    r = await client.delete("/api/hidden-channels/chan1")
    assert r.json() == {"channel_id": "chan1", "hidden": False}
    assert (await client.get("/api/hidden-channels")).json()["channel_ids"] == []


async def test_unhiding_a_visible_channel_is_not_an_error(client):
    assert (await client.delete("/api/hidden-channels/never-hidden")).status_code == 200


async def test_bulk_import_returns_the_merged_set(client):
    """The one-time migration from localStorage — has to be safe to re-run, and
    must not drop anything hidden since."""
    await client.post("/api/hidden-channels/already-hidden")
    r = await client.post(
        "/api/hidden-channels/import", json={"channel_ids": ["a", "b", "already-hidden"]}
    )
    assert r.json()["channel_ids"] == ["a", "already-hidden", "b"]

    again = await client.post("/api/hidden-channels/import", json={"channel_ids": ["a", "b"]})
    assert again.json()["channel_ids"] == ["a", "already-hidden", "b"]


async def test_import_skips_empty_ids(client):
    """A localStorage blob with a stray empty string shouldn't hide a channel
    with no id — which would then be un-hideable through the UI."""
    r = await client.post("/api/hidden-channels/import", json={"channel_ids": ["", "a", ""]})
    assert r.json()["channel_ids"] == ["a"]
