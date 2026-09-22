"""What has to be true before the app can serve a request.

Idempotent, and run on every boot, because the interesting case is the boot
where none of it is true yet: a fresh container with an empty volume and nothing
in it. A directory the app expects to write into has to exist before the first
background job reaches for it and fails where nobody is watching.
"""

from __future__ import annotations

import os
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


def prepare() -> None:
    """Make the data directory usable. Called once, at import, from main.py."""
    for sub in _DATA_SUBDIRS:
        Path(settings.data_dir, sub).mkdir(parents=True, exist_ok=True)
    # config_dir may have been pointed somewhere else entirely.
    Path(settings.config_dir).mkdir(parents=True, exist_ok=True)

    adopted = _adopt_legacy_config()
    if adopted:
        print(f"[bootstrap] adopted from backend/config/: {', '.join(adopted)}",
              flush=True)


def data_dir_note() -> str:
    """One line for the startup log saying where state is being kept."""
    return f"[bootstrap] data dir: {settings.data_dir}" + (
        "" if _default_config_dir() else f" (config: {settings.config_dir})"
    )
