"""Coming up on an empty volume, and not dragging the last deployment along.

The first boot is the one worth testing, because it is the boot where nothing is
true yet: not even the directories. And the *upgrade* boot, where config used to
live inside the repository and now lives on the data volume — a copy that has to
happen once, and must not happen in a test run.

That last clause is not hypothetical. An earlier version of the guard inferred
whether to adopt from whether `CONFIG_DIR` looked like the derived default, and
the harness sets both `DATA_DIR` and `CONFIG_DIR`, so it looked default: a test
run copied the developer's live OAuth token into its own temp directory and
started making real YouTube API calls with it. Hence `SKIP_CONFIG_ADOPTION`, and
hence these tests.
"""

import pytest

from app import bootstrap
from app.config import settings


@pytest.fixture
def volume(tmp_path, monkeypatch):
    """A `data_dir` of its own, as a freshly mounted volume is."""
    monkeypatch.setattr(settings, "data_dir", str(tmp_path / "data"))
    monkeypatch.setattr(settings, "config_dir", str(tmp_path / "data" / "config"))
    return tmp_path


@pytest.fixture
def legacy(tmp_path, monkeypatch):
    """A `backend/config/` from before the move, with something in it."""
    old = tmp_path / "repo" / "backend" / "config"
    old.mkdir(parents=True)
    (old / "subscriptions.yaml").write_text("channels:\n  - UCsomething\n")
    (old / "youtube_oauth_token.json").write_text('{"token": "live-credential"}')
    monkeypatch.setattr(bootstrap, "_LEGACY_CONFIG_DIR", old)
    return old


# ── The directories ──────────────────────────────────────────────────


def test_a_fresh_volume_gets_the_directories_it_needs(volume):
    """SQLite will not create a missing directory, and neither will the scan when
    it reaches for somewhere to put a download."""
    bootstrap.prepare()

    for sub in ("config", "downloads", "local_thumbs", "asr-audio"):
        assert (volume / "data" / sub).is_dir(), sub


def test_preparing_twice_changes_nothing(volume):
    """It runs on every boot."""
    bootstrap.prepare()
    bootstrap.prepare()

    assert (volume / "data" / "config").is_dir()


# ── Adoption ─────────────────────────────────────────────────────────


def test_config_from_the_old_location_is_brought_forward(volume, legacy, monkeypatch):
    monkeypatch.delenv("SKIP_CONFIG_ADOPTION", raising=False)
    bootstrap.prepare()

    assert (volume / "data" / "config" / "subscriptions.yaml").is_file()
    # And the original is still there: copied, not moved, so rolling back to an
    # older build of this app still finds its config where it left it.
    assert (legacy / "subscriptions.yaml").is_file()


def test_adoption_never_overwrites_what_is_already_there(volume, legacy, monkeypatch):
    monkeypatch.delenv("SKIP_CONFIG_ADOPTION", raising=False)
    (volume / "data" / "config").mkdir(parents=True)
    (volume / "data" / "config" / "subscriptions.yaml").write_text("channels: []\n")

    bootstrap.prepare()

    assert (volume / "data" / "config" / "subscriptions.yaml").read_text() == "channels: []\n"


def test_the_flag_stops_a_test_run_inheriting_live_credentials(volume, legacy, monkeypatch):
    """The regression this file exists for. `SKIP_CONFIG_ADOPTION` is set by the
    harness, and with it set nothing is copied — not the subscription list and
    above all not the OAuth token, which is a live credential for a real Google
    account and has no business in a test's temp directory."""
    monkeypatch.setenv("SKIP_CONFIG_ADOPTION", "1")

    bootstrap.prepare()

    assert not (volume / "data" / "config" / "youtube_oauth_token.json").exists()
    assert not (volume / "data" / "config" / "subscriptions.yaml").exists()


def test_a_config_dir_pointed_elsewhere_is_not_overwritten(tmp_path, legacy, monkeypatch):
    """Naming a config directory outright means it — adoption is for the
    deployment that never chose one."""
    monkeypatch.delenv("SKIP_CONFIG_ADOPTION", raising=False)
    monkeypatch.setattr(settings, "data_dir", str(tmp_path / "data"))
    monkeypatch.setattr(settings, "config_dir", str(tmp_path / "somewhere-else"))

    bootstrap.prepare()

    assert not (tmp_path / "somewhere-else" / "subscriptions.yaml").exists()
