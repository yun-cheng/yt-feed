"""API keys as settings — which is to say, a value the API takes but never gives.

The reason keys moved into Settings is that requiring a file before the app will
start is the step a person deploying this gets wrong, and gets wrong quietly: the
app comes up and the half of it that needs the key is missing. A form is harder
to get wrong.

What that buys has to be paid for in one place: a settings endpoint now holds
every credential the deployment has, and `GET /api/settings` is called on every
visit to the settings page. So the test that matters most here is that reading
them back is impossible — not inconvenient, not authenticated, impossible.

The precedence tests are the other half. These values fall back to the
environment, so a key in `.env` has to keep working, and clearing one in the UI
has to reveal it again rather than appearing to do nothing.
"""

import pytest

from app import app_settings, runtime_config
from app.config import settings as env_settings

SECRETS = ("openrouter_api_key", "google_client_id", "google_client_secret",
           "meili_master_key")


# ── Never readable ───────────────────────────────────────────────────


async def test_a_stored_key_does_not_come_back_out(client):
    await client.put("/api/settings", json={"values": {
        "openrouter_api_key": "sk-or-v1-the-actual-secret",
    }})

    body = await client.get("/api/settings")

    assert "sk-or-v1-the-actual-secret" not in body.text
    assert body.json()["values"]["openrouter_api_key"]["set"] is True


async def test_every_secret_reads_as_a_flag_and_a_hint(client):
    """Exhaustive over the secret keys, because this is the property that must
    hold for all of them and a new one added without it would be silent."""
    values = (await client.get("/api/settings")).json()["values"]

    for key in SECRETS:
        assert set(values[key]) == {"set", "hint", "from_env"}, key


async def test_the_hint_is_the_tail_and_is_too_short_to_use(client):
    """The tail, not the head: every OpenRouter key ever issued starts
    `sk-or-v1-`, so the head distinguishes nothing. Four characters is enough to
    recognise which key you pasted."""
    await client.put("/api/settings", json={"values": {
        "openrouter_api_key": "sk-or-v1-abcdefghijklmnop",
    }})

    hint = (await client.get("/api/settings")).json()["values"]["openrouter_api_key"]["hint"]

    assert hint == "…mnop"


async def test_the_test_endpoint_reports_without_echoing(client):
    """It reaches OpenRouter with the key; it reports whether that worked."""
    await client.put("/api/settings", json={"values": {"openrouter_api_key": ""}})

    r = await client.post("/api/settings/test/openrouter_api_key")

    assert r.json() == {"ok": False, "text": "No key set."}


async def test_a_setting_that_cannot_be_tested_says_so(client):
    """Rather than reporting a cheerful nothing. The Google client can only be
    checked by completing a consent flow, which is its own answer."""
    assert (await client.post("/api/settings/test/google_client_id")).status_code == 404


# ── Precedence ───────────────────────────────────────────────────────


async def test_a_stored_value_beats_the_environment(client, monkeypatch):
    monkeypatch.setattr(env_settings, "openrouter_api_key", "from-dot-env")
    await client.put("/api/settings", json={"values": {"openrouter_api_key": "from-the-ui"}})

    assert runtime_config.openrouter_api_key() == "from-the-ui"


async def test_the_environment_answers_when_nothing_is_stored(client, monkeypatch):
    """So an existing deployment's `.env` keeps working untouched — this change
    had to be additive."""
    monkeypatch.setattr(env_settings, "openrouter_api_key", "from-dot-env")

    assert runtime_config.openrouter_api_key() == "from-dot-env"


async def test_clearing_a_key_reveals_the_environment_rather_than_disabling(
    client, monkeypatch
):
    """An emptied field is a value REMOVED, not a value of "".

    Stored as "" it would shadow the environment variable, so clearing a key in
    the UI would turn off a feature that `.env` still configures — and the page
    would report it as not set while the file said otherwise.
    """
    monkeypatch.setattr(env_settings, "openrouter_api_key", "from-dot-env")
    await client.put("/api/settings", json={"values": {"openrouter_api_key": "from-the-ui"}})

    await client.put("/api/settings", json={"values": {"openrouter_api_key": ""}})

    assert runtime_config.openrouter_api_key() == "from-dot-env"
    view = (await client.get("/api/settings")).json()["values"]["openrouter_api_key"]
    assert view["set"] is True
    assert view["from_env"] is True


async def test_a_key_from_the_environment_is_marked_as_such(client, monkeypatch):
    """So the page doesn't invite you to fill in a field that's already answered
    somewhere you'd have to go and look for."""
    monkeypatch.setattr(env_settings, "openrouter_api_key", "from-dot-env")

    view = (await client.get("/api/settings")).json()["values"]["openrouter_api_key"]

    assert (view["set"], view["from_env"]) == (True, True)


async def test_a_key_set_here_is_not_marked_as_from_the_environment(client, monkeypatch):
    monkeypatch.setattr(env_settings, "openrouter_api_key", "from-dot-env")
    await client.put("/api/settings", json={"values": {"openrouter_api_key": "from-the-ui"}})

    view = (await client.get("/api/settings")).json()["values"]["openrouter_api_key"]

    assert view["from_env"] is False


# ── What's refused ───────────────────────────────────────────────────


async def test_a_newline_in_a_one_line_credential_is_refused(client):
    """A paste that went wrong. Joined silently instead, the result is a key that
    authenticates as nothing — and a newline inside an Authorization header is a
    request httpx won't send at all, which reads as a rejected key."""
    r = await client.put("/api/settings", json={"values": {
        "openrouter_api_key": "sk-or-v1-abc\ndef",
    }})

    assert r.status_code == 400
    assert "single line" in r.text


async def test_surrounding_whitespace_is_stripped(client):
    """Because a key copied out of a web page arrives with a newline on it more
    often than not."""
    await client.put("/api/settings", json={"values": {
        "openrouter_api_key": "  sk-or-v1-abcd\n",
    }})

    assert runtime_config.openrouter_api_key() == "sk-or-v1-abcd"


async def test_an_over_long_value_is_refused(client):
    r = await client.put("/api/settings", json={"values": {
        "openrouter_api_key": "x" * 5000,
    }})

    assert r.status_code == 400
    assert "characters" in r.text


async def test_a_non_string_is_refused(client):
    r = await client.put("/api/settings", json={"values": {"openrouter_api_key": 42}})

    assert r.status_code == 400


# ── The spec the page renders from ───────────────────────────────────


def test_the_connections_group_carries_what_a_control_needs():
    spec = {s["key"]: s for s in app_settings.described()}

    assert spec["openrouter_api_key"]["testable"] is True
    assert spec["openrouter_api_key"]["placeholder"]
    assert spec["openrouter_api_key"]["multiline"] is False
    # Only what a round trip can check: the Google client needs a consent flow.
    assert spec["google_client_id"]["testable"] is False


def test_every_connection_setting_is_the_deployments_not_a_persons():
    """A per-person copy of an API key would mean whoever saved last decides
    whose account gets billed."""
    for s in app_settings.described():
        if s["group"] == "Connections":
            assert s["scope"] == "app", s["key"]
