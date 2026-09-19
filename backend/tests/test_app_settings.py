"""App settings: the preferences that live in the app rather than in .env."""

import pytest

from app import app_settings


@pytest.mark.asyncio
async def test_an_unset_setting_falls_back_to_its_bootstrap_default():
    """.env seeds the first read and is then ignored — one source of truth, not
    two disagreeing ones."""
    assert await app_settings.get("archive_fill_enabled") is False


@pytest.mark.asyncio
async def test_a_stored_value_wins_over_the_env_default(monkeypatch):
    from app.config import settings as env_settings

    monkeypatch.setattr(env_settings, "archive_fill_enabled", True)
    await app_settings.put({"archive_fill_enabled": False})
    assert await app_settings.get("archive_fill_enabled") is False


@pytest.mark.asyncio
async def test_a_setting_survives_being_written_twice():
    await app_settings.put({"archive_fill_enabled": True})
    await app_settings.put({"archive_fill_enabled": False})
    assert await app_settings.get("archive_fill_enabled") is False


@pytest.mark.asyncio
async def test_an_unknown_key_is_refused_rather_than_stored():
    """A typo that silently writes a key nothing reads is worse than an error."""
    with pytest.raises(KeyError):
        await app_settings.put({"archive_fil_enabled": True})


@pytest.mark.asyncio
async def test_the_api_serves_the_spec_beside_the_values(client):
    """The page renders itself from this, which is what keeps adding a setting
    to one entry in SPEC."""
    res = await client.get("/api/settings")
    body = res.json()
    assert res.status_code == 200
    keys = {s["key"] for s in body["settings"]}
    assert keys == set(body["values"])
    spec = next(s for s in body["settings"] if s["key"] == "archive_fill_enabled")
    assert spec["type"] == "bool" and spec["label"] and spec["description"]


@pytest.mark.asyncio
async def test_writing_a_setting_returns_the_new_state(client):
    res = await client.put("/api/settings", json={"values": {"archive_fill_enabled": True}})
    assert res.status_code == 200
    assert res.json()["values"]["archive_fill_enabled"] is True
    assert (await client.get("/api/settings")).json()["values"]["archive_fill_enabled"] is True


@pytest.mark.asyncio
async def test_writing_an_unknown_setting_is_a_400(client):
    res = await client.put("/api/settings", json={"values": {"nope": 1}})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_page_defaults_round_trip_as_an_object(client):
    """Stored as JSON text, served back as the object that was written."""
    value = {"feed": {"age": "0-7", "sort": "score"}, "history": {"watch": ["watched"]}}
    res = await client.put("/api/settings", json={"values": {"page_defaults": value}})
    assert res.status_code == 200
    assert (await client.get("/api/settings")).json()["values"]["page_defaults"] == value


@pytest.mark.asyncio
async def test_page_defaults_start_empty(client):
    """Nothing overridden: every page follows the frontend's built-in table."""
    assert (await client.get("/api/settings")).json()["values"]["page_defaults"] == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", [[], "feed", {"feed": "newest"}])
async def test_page_defaults_of_the_wrong_shape_are_a_400(client, bad):
    res = await client.put("/api/settings", json={"values": {"page_defaults": bad}})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_language_settings_start_on_the_browser_and_the_videos_own(client):
    values = (await client.get("/api/settings")).json()["values"]
    assert (values["app_language"], values["caption_lang"], values["caption_lang2"]) == ("auto", "", "")


@pytest.mark.asyncio
async def test_a_choice_serves_its_options_in_menu_order(client):
    spec = {s["key"]: s for s in (await client.get("/api/settings")).json()["settings"]}
    assert [o["value"] for o in spec["app_language"]["options"]] == ["auto", "en", "zh-Hant"]
    assert [o["value"] for o in spec["caption_lang"]["options"]] == ["", "en", "zh", "ja", "ko"]
    assert "options" not in spec["page_defaults"]


@pytest.mark.asyncio
async def test_a_choice_round_trips(client):
    res = await client.put("/api/settings", json={"values": {"app_language": "zh-Hant", "caption_lang": "ja"}})
    assert res.status_code == 200
    values = (await client.get("/api/settings")).json()["values"]
    assert (values["app_language"], values["caption_lang"]) == ("zh-Hant", "ja")


@pytest.mark.asyncio
@pytest.mark.parametrize("key,bad", [("app_language", "fr"), ("caption_lang", "zh-Hant"), ("caption_lang2", None)])
async def test_a_choice_outside_its_options_is_a_400(client, key, bad):
    res = await client.put("/api/settings", json={"values": {key: bad}})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_a_stored_option_since_retired_reads_as_the_default(client):
    from app.database import async_session
    from app.models import UserSetting
    from sqlalchemy import select
    await client.put("/api/settings", json={"values": {"caption_lang": "ja"}})
    async with async_session() as session:
        row = (await session.execute(select(UserSetting).where(UserSetting.key == "caption_lang"))).scalar_one()
        row.value = "fr"
        await session.commit()
    assert (await client.get("/api/settings")).json()["values"]["caption_lang"] == ""


@pytest.mark.asyncio
async def test_the_fill_does_nothing_while_the_setting_is_off():
    from app import archive

    await app_settings.put({"archive_fill_enabled": False})
    assert await archive.archive_phase() is None


@pytest.mark.asyncio
async def test_turning_the_fill_off_stops_a_sweep_already_running(monkeypatch):
    """The switch has to be a kill switch, not just a start button: a sweep runs
    for minutes, and turning it off between channels must actually stop it."""
    from app import archive
    from app.database import async_session
    from app.models import Channel

    async with async_session() as s:
        for cid in ("a", "b", "c"):
            s.add(Channel(youtube_id=cid, title=cid, lifetime_count=100))
        await s.commit()

    await app_settings.put({"archive_fill_enabled": True})
    walked = []

    async def fill(channel_id, budget):
        walked.append(channel_id)
        # Someone hits the toggle while the first channel is being walked.
        await app_settings.put({"archive_fill_enabled": False})
        return {"added": 0, "new_ids": [], "spent": 1, "pages": 1,
                "exhausted": False, "stopped": "budget"}

    async def no_counts(*a, **k):
        return 0

    monkeypatch.setattr(archive, "fill_channel", fill)
    monkeypatch.setattr(archive, "refresh_lifetime_counts", no_counts)

    result = await archive.run_archive_fill()
    assert result["stopped"] == "disabled"
    assert len(walked) == 1  # it stopped instead of working through b and c
