"""Coming up on an empty volume, and not dragging the last deployment along.

The first boot is the one worth testing, because it is the boot where nothing is
true yet: no directories, no session key, nobody signed in. And the *upgrade*
boot, where config used to live inside the repository and now lives on the data
volume — a copy that has to happen once, and must not happen in a test run.

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
    monkeypatch.setattr(settings, "secret_key", "")
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
    first = bootstrap.prepare()
    assert bootstrap.prepare() == first


# ── The session key ──────────────────────────────────────────────────


def test_a_key_is_generated_when_none_is_configured(volume):
    """The hole this closes: a published default key signs forgeable cookies, so
    anyone who read the source could mint a session saying "I am user 1"."""
    key = bootstrap.prepare()

    assert len(key) >= 40
    assert key != "change-me-in-production"
    assert (volume / "data" / "secret_key").read_text().strip() == key


def test_the_generated_key_survives_a_restart(volume):
    """Otherwise every container rebuild signs everybody out."""
    first = bootstrap.prepare()
    second = bootstrap.prepare()

    assert first == second


def test_two_deployments_do_not_share_a_key(tmp_path, monkeypatch):
    """The whole point of generating it. Two people who ran the same compose file
    must not be able to forge each other's cookies."""
    keys = set()
    for name in ("one", "two"):
        monkeypatch.setattr(settings, "data_dir", str(tmp_path / name))
        monkeypatch.setattr(settings, "config_dir", str(tmp_path / name / "config"))
        monkeypatch.setattr(settings, "secret_key", "")
        keys.add(bootstrap.prepare())

    assert len(keys) == 2


def test_a_configured_key_is_left_alone(volume, monkeypatch):
    """Someone running several instances behind one load balancer needs to set
    it themselves, and generating over the top would break exactly that."""
    monkeypatch.setattr(settings, "secret_key", "i-chose-this-myself")

    assert bootstrap.prepare() == "i-chose-this-myself"
    assert not (volume / "data" / "secret_key").exists()


# ── The setup token ──────────────────────────────────────────────────


def test_a_setup_token_is_written_and_read_back(volume):
    bootstrap.prepare()

    token = bootstrap.setup_token()
    assert len(token) >= 20
    assert (volume / "data" / "setup-token").read_text().strip() == token


def test_the_setup_token_is_stable_across_boots(volume):
    """The deployer copies it out of the log once; a token that rotated on
    restart would be gone by the time they pasted it."""
    bootstrap.prepare()
    first = bootstrap.setup_token()
    bootstrap.prepare()

    assert bootstrap.setup_token() == first


def test_no_token_file_reads_as_no_token_rather_than_raising(volume):
    """`setup_token()` is called on a request path, and "" is refused by the
    comparison in routers/setup.py — so a missing file closes the door rather
    than opening it with a 500."""
    assert bootstrap.setup_token() == ""


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
    monkeypatch.setattr(settings, "secret_key", "")

    bootstrap.prepare()

    assert not (tmp_path / "somewhere-else" / "subscriptions.yaml").exists()
