"""The keys and connection details, as the code that uses them sees them.

Two places can supply a value. `app_settings` stores what was typed into
**Settings → Connections**, which is how a deployment nobody wants to hand-edit
files for gets configured. `config.py` reads the environment, which is how this
app was configured before there was a UI and how a deployer who prefers files
still can. **Stored wins**, and an unset stored value falls through rather than
reading as empty — so turning a key off in the UI reveals the env value rather
than silently disabling a feature the environment still configures.

That precedence is already the pattern here: `archive_fill_enabled` has used its
`.env` value as a bootstrap default since app_settings was written. This module
is the same idea for the values that are secrets.

**Why it reads SQLite directly, and synchronously.** Every caller is sync —
`llm.chat` posts with httpx.post and `search_index._headers` builds a dict —
and neither of them can await. An
`asyncio.run` from inside the request loop would raise, and a cache that had to
be primed by the lifespan would be empty in the test suite (which doesn't run
one) and in the scan thread (which has its own loop). One read-only sqlite3
query, cached until something writes, is smaller than any of the alternatives and
behaves the same everywhere.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from app.config import settings as env_settings

# The keys this module answers for, and the `.env` field each falls back to.
_ENV_FIELD = {
    "openrouter_api_key": "openrouter_api_key",
    "google_client_id": "google_client_id",
    "google_client_secret": "google_client_secret",
    "meili_master_key": "meili_master_key",
}

_stored: dict[str, str] | None = None


def _read_stored() -> dict[str, str]:
    """Every `app_settings` row, as a plain dict.

    Read-only URI mode so a database that doesn't exist yet stays non-existent:
    a plain `sqlite3.connect` would CREATE the file, and an empty file where
    SQLAlchemy expects to set up WAL is a worse problem than a missing value.
    """
    try:
        conn = sqlite3.connect(f"file:{env_settings.db_path}?mode=ro", uri=True)
    except sqlite3.OperationalError:
        return {}
    try:
        rows = conn.execute("SELECT key, value FROM app_settings").fetchall()
    except sqlite3.Error:
        # No such table yet — a fresh database before `init_db`.
        return {}
    finally:
        conn.close()
    return {k: v for k, v in rows if v}


def invalidate() -> None:
    """Forget the cache. Called whenever a setting is written."""
    global _stored
    _stored = None


def get(key: str) -> str:
    """One value: stored if set, else the environment, else empty."""
    global _stored
    if _stored is None:
        _stored = _read_stored()
    value = _stored.get(key, "")
    if value:
        return value
    field = _ENV_FIELD.get(key)
    return getattr(env_settings, field, "") if field else ""


def is_set(key: str) -> bool:
    return bool(get(key))


def hint(key: str) -> str:
    """A few characters of a secret, for showing that one is set.

    The tail rather than the head: an OpenRouter key's head is `sk-or-v1-` on
    every key ever issued, so it distinguishes nothing. Four characters is enough
    to recognise which key you pasted and far too few to use.
    """
    value = get(key)
    return f"…{value[-4:]}" if len(value) > 4 else ("…" if value else "")


# --- Named accessors ---------------------------------------------------------
# One per key, so call sites read as they did when these were plain attributes on
# `settings` and a reader doesn't have to know this module's vocabulary.


def openrouter_api_key() -> str:
    return get("openrouter_api_key")


def google_client_id() -> str:
    return get("google_client_id")


def google_client_secret() -> str:
    return get("google_client_secret")


def meili_master_key() -> str:
    return get("meili_master_key")
