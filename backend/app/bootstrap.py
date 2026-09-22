"""What has to be true before the app can serve a request.

Everything here is idempotent and runs on every boot, because the interesting
case is the boot where none of it is true yet: a fresh container with an empty
volume, nobody signed in, no keys set. That deployment has to come up and be
*claimable* rather than come up broken, and it has to come up without a session
key its author already knows.

Split in two, by what each half can reach:

  * `prepare()` runs at import time, from main.py, because the session
    middleware is constructed at import and needs the key. No database — the
    engine is built from `settings.db_path` in the same breath.
  * `announce_setup()` runs in the lifespan, where the database exists, and is
    the half that can ask whether anybody owns this deployment yet.
"""

from __future__ import annotations

import os
import secrets
import shutil
from pathlib import Path

from app.config import settings

# The directories the app writes into, all under `data_dir`. Created rather than
# assumed: a mounted volume starts empty, and the first thing to reach for one of
# these is usually a background job whose failure nobody is watching.
_DATA_SUBDIRS = ("config", "downloads", "local_thumbs", "asr-audio")

# Where config used to live, before it moved onto the data volume. Files here are
# COPIED forward, never moved — see `_adopt_legacy_config`.
_LEGACY_CONFIG_DIR = Path(settings.project_root) / "backend" / "config"
_LEGACY_FILES = ("subscriptions.yaml", "categories.yaml", "youtube_oauth_token.json")


def _default_config_dir() -> bool:
    """Whether `config_dir` is the one derived from `data_dir`."""
    return Path(settings.config_dir) == Path(settings.data_dir) / "config"


def _adoption_allowed() -> bool:
    """Whether this process should inherit config from the old location.

    An explicit opt-out rather than a guess, and it is the test harness that
    needs it. An earlier version of this inferred the answer — "adopt unless
    CONFIG_DIR was pointed somewhere unusual" — and it was wrong in the worst
    available way: the harness also sets DATA_DIR, which made its temp config
    directory look like the derived default, so a test run copied the real
    feed's OAuth token into itself and started making live YouTube API calls
    with it. Tests that hold live credentials are a bad enough outcome to be
    worth a flag; a heuristic that can silently decide otherwise is not.
    """
    return os.environ.get("SKIP_CONFIG_ADOPTION", "").lower() not in ("1", "true", "yes")


def _adopt_legacy_config() -> list[str]:
    """Bring forward config from `backend/config/`, if that's where it still is.

    Copied, not moved, and only where the new location has nothing of that name.
    Copying means an older build of this app still starts, and means this can't
    be the step that loses somebody's subscription list. The leftovers are safe
    to delete by hand once the app has been up — the README says so.
    """
    if not _adoption_allowed() or not _default_config_dir():
        return []
    if not _LEGACY_CONFIG_DIR.is_dir():
        return []
    adopted = []
    for name in _LEGACY_FILES:
        src, dst = _LEGACY_CONFIG_DIR / name, Path(settings.config_dir) / name
        if src.is_file() and not dst.exists():
            shutil.copy2(src, dst)
            adopted.append(name)
    return adopted


def _resolve_secret_key() -> str:
    """The key that signs the session cookie, generated on first boot if need be.

    A configured `SECRET_KEY` wins, so an existing deployment and anyone who
    prefers to manage it themselves are unaffected. Otherwise it is generated
    once and kept beside the database, which makes the useful default true: a
    deployment nobody configured still has a key nobody else knows, and it
    survives restarts, so a container rebuild doesn't sign everybody out.

    0600, and on the same volume as the database — which is already the more
    valuable of the two, so this asks for no trust that wasn't already given.
    """
    if settings.secret_key:
        return settings.secret_key

    path = Path(settings.secret_key_path)
    try:
        existing = path.read_text().strip()
        if existing:
            return existing
    except OSError:
        pass

    key = secrets.token_urlsafe(48)
    path.write_text(key)
    try:
        path.chmod(0o600)
    except OSError:
        # A volume that won't take a mode change (some bind mounts, Windows
        # hosts) is not a reason to refuse to boot. The key is still private to
        # whoever can read the volume, which is whoever can read the database.
        pass
    return key


def _ensure_setup_token() -> str:
    """The token that claims an unclaimed deployment.

    Written unconditionally because this can't see the database, and read back on
    every boot so it stays the same one the deployer copied out of the logs.
    Whether it means anything is `app.routers.setup`'s question: it stops being
    accepted the moment an account exists, so a long-lived file is not a
    long-lived way in.
    """
    path = Path(settings.setup_token_path)
    try:
        existing = path.read_text().strip()
        if existing:
            return existing
    except OSError:
        pass

    token = secrets.token_urlsafe(24)
    path.write_text(token)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return token


def setup_token() -> str:
    """The current setup token, or "" if it can't be read."""
    try:
        return Path(settings.setup_token_path).read_text().strip()
    except OSError:
        return ""


def prepare() -> str:
    """Make the data directory usable, and answer with the session key.

    Returns the key rather than setting it on `settings`, so the one caller that
    needs it (the session middleware) takes it as an argument and nothing else is
    tempted to read a secret off the settings object.
    """
    for sub in _DATA_SUBDIRS:
        Path(settings.data_dir, sub).mkdir(parents=True, exist_ok=True)
    # config_dir may have been pointed somewhere else entirely.
    Path(settings.config_dir).mkdir(parents=True, exist_ok=True)

    adopted = _adopt_legacy_config()
    if adopted:
        print(f"[bootstrap] adopted from backend/config/: {', '.join(adopted)}",
              flush=True)

    _ensure_setup_token()
    return _resolve_secret_key()


async def announce_setup() -> None:
    """Print the way in, on a deployment that nobody has claimed yet.

    The logs are the one channel a fresh deployment has to its deployer that an
    unclaimed HTTP endpoint doesn't: `docker compose logs app` reaches the person
    who ran it, and the open port reaches everybody. So the token goes here, and
    the first person to present it becomes the owner.
    """
    from app import users
    from app.database import async_session

    async with async_session() as session:
        if await users.owner_id(session) is not None:
            return

    token = setup_token()
    origin = settings.public_url or settings.app_origin
    # `flush` because this is the one message whose entire purpose is to reach a
    # human through a pipe, and Python block-buffers stdout when it isn't a tty.
    # Without it, `docker compose logs app | grep setup` finds nothing — the
    # claim link sits in a 8KB buffer that a long-running server never fills. The
    # image sets PYTHONUNBUFFERED, but the one channel into a fresh deployment
    # shouldn't depend on an environment variable being right.
    print(
        "\n[setup] Nobody owns this deployment yet. Claim it:\n"
        f"[setup]   {origin.rstrip('/')}/setup?token={token}\n"
        "[setup] Until then, nobody can sign in and nothing can be configured.\n",
        flush=True,
    )


def data_dir_note() -> str:
    """One line for the startup log saying where state is being kept."""
    return f"[bootstrap] data dir: {settings.data_dir}" + (
        "" if _default_config_dir() else f" (config: {settings.config_dir})"
    )
