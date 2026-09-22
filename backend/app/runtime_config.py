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
`llm.chat` posts with httpx.post, `search_index._headers` builds a dict,
`ytdl.opts` is called from a worker thread — and none of them can await. An
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

# The keys this module answers for, and where each one comes from if nothing is
# stored. A key absent from `_ENV_FIELD` has no environment twin on purpose:
# a cookie jar is thousands of characters of someone's session, which is not
# something to put in an environment variable or a compose file.
_ENV_FIELD = {
    "openrouter_api_key": "openrouter_api_key",
    "google_client_id": "google_client_id",
    "google_client_secret": "google_client_secret",
    "meili_master_key": "meili_master_key",
    "youtube_proxy": "youtube_proxy",
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


def youtube_proxy() -> str:
    return get("youtube_proxy")


def youtube_cookies_file() -> str:
    """Path to the yt-dlp cookie jar, or "" if there is nothing to read.

    yt-dlp takes a path, so the value stored in the database is materialised to
    `settings.cookies_path` by `write_cookies_file` when it changes. A file put
    there by hand works too, and is the way to use cookies without pasting them
    into a web form — nothing here overwrites it unless the setting is written.
    """
    stored = get("youtube_cookies")
    path = Path(env_settings.cookies_path)
    if stored and not path.is_file():
        # The setting outlived its file: a volume restored without config/, say.
        write_cookies_file(stored)
    return str(path) if path.is_file() else ""


def write_cookies_file(contents: str) -> None:
    """Put the cookie jar on disk, or take it away.

    Written 0600 and under `config_dir` beside the OAuth token, which is the
    other live credential this app keeps as a file. Empty contents delete it
    rather than leaving an empty jar, because yt-dlp treats an empty cookie file
    as a valid one and would stop telling us it has no cookies.
    """
    path = Path(env_settings.cookies_path)
    if not contents.strip():
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents if contents.endswith("\n") else contents + "\n")
    try:
        path.chmod(0o600)
    except OSError:
        pass
