"""The shared floor under every yt-dlp call, and the two options that matter.

Cookies and a proxy have to be on *every* extraction or the app half-works in a
way that is very hard to read: titles arrive from one code path and captions fail
from another. So the test worth having is not "does `opts()` return a dict" but
"does every call site go through it" — which is a fact about five other modules
and the nine places in them that reach yt-dlp, and is checked here by reading them.
"""

import re
from pathlib import Path

import pytest

from app import runtime_config, ytdl
from app.config import settings as env_settings

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def clean():
    """Recorded history and the cookie jar, both reset.

    The jar is a FILE, and `youtube_cookies_file()` answers on whether it exists —
    deliberately, so a jar dropped onto the volume by hand works without going
    through a web form. Which means a test that writes one leaves it for the next
    test in the module, and the database reset between them doesn't touch it.
    """
    def wipe():
        ytdl.reset()
        runtime_config.invalidate()
        Path(env_settings.cookies_path).unlink(missing_ok=True)

    wipe()
    yield
    wipe()


# ── The options ──────────────────────────────────────────────────────


def test_the_floor_is_there_without_anything_configured():
    o = ytdl.opts()

    assert o["quiet"] is True
    assert o["no_warnings"] is True
    # The logger is how a failure gets recorded at all — see the status tests.
    assert o["logger"] is not None


def test_nothing_is_passed_that_was_not_asked_for():
    """An unset cookie file would make yt-dlp read a path that isn't there, and
    an empty proxy string is a proxy of "" rather than no proxy."""
    o = ytdl.opts()

    assert "cookiefile" not in o
    assert "proxy" not in o


def test_a_call_sites_own_options_survive(monkeypatch):
    o = ytdl.opts(skip_download=True, extractor_args={"youtube": {"skip": ["dash"]}})

    assert o["skip_download"] is True
    assert o["extractor_args"] == {"youtube": {"skip": ["dash"]}}


def test_a_call_site_can_override_the_floor():
    """`extra` wins, so a site with a reason to differ keeps it rather than having
    to stop using the shared options to get it."""
    assert ytdl.opts(quiet=False)["quiet"] is False


def test_the_proxy_is_passed_when_set(monkeypatch):
    monkeypatch.setattr(env_settings, "youtube_proxy", "http://box:8080")
    runtime_config.invalidate()

    assert ytdl.opts()["proxy"] == "http://box:8080"


async def test_the_cookie_jar_is_passed_when_there_is_one(client):
    await client.put("/api/settings", json={"values": {
        "youtube_cookies": "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tA\tb",
    }})

    assert ytdl.opts()["cookiefile"] == env_settings.cookies_path


# ── Every call site goes through it ──────────────────────────────────


def test_no_call_site_builds_its_own_options():
    """Read across the app, because this is the property that makes the feature
    work at all: an extraction that skipped `ytdl.opts` would ignore the cookies
    and the proxy, and would fail while everything around it succeeded.

    `quiet` is the marker — it was in all nine of the hand-rolled dicts, so a
    literal `"quiet":` in a dict outside ytdl.py means somebody wrote a new one.
    """
    offenders = []
    for path in sorted((BACKEND / "app").rglob("*.py")):
        if path.name == "ytdl.py" or "__pycache__" in path.parts:
            continue
        for n, line in enumerate(path.read_text().splitlines(), 1):
            if re.search(r'["\']quiet["\']\s*:', line):
                offenders.append(f"{path.relative_to(BACKEND)}:{n}")

    assert offenders == [], (
        "these build yt-dlp options by hand and so ignore the cookies and proxy "
        f"settings: {offenders}"
    )


def test_every_youtubedl_construction_is_given_shared_options():
    """The other half of the same check, from the other end: count the
    constructions and require each to mention `ytdl.opts` or a variable built
    from it."""
    constructions = []
    for path in sorted((BACKEND / "app").rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        text = path.read_text()
        for n, line in enumerate(text.splitlines(), 1):
            if "yt_dlp.YoutubeDL(" in line:
                constructions.append((path.relative_to(BACKEND), n, line.strip()))

    assert constructions, "nothing constructs a YoutubeDL — has the scan moved?"
    for rel, n, line in constructions:
        assert re.search(r"YoutubeDL\((ytdl\.opts\(|opts\)|ydl_opts\))", line), \
            f"{rel}:{n} builds a YoutubeDL from something else: {line}"


# ── Saying when YouTube is blocking ──────────────────────────────────


def test_nothing_fetched_yet_says_so_rather_than_claiming_health():
    assert "Nothing fetched yet" in ytdl.status()["text"]
    assert ytdl.status()["blocked"] is False


def test_a_bot_check_is_reported_as_itself():
    """The one failure with a known remedy. Reported as "extraction failed" it
    sends people to look at their network, their channels, their disk — anywhere
    but the setting that fixes it."""
    ytdl.note_failure(
        "ERROR: [youtube] abc123: Sign in to confirm you're not a bot. "
        "Use --cookies-from-browser or --cookies"
    )

    s = ytdl.status()
    assert s["blocked"] is True
    assert s["bot_checks"] == 1
    assert "not a bot" in s["text"]
    assert "Cookies" in s["text"]


def test_an_ordinary_failure_is_not_called_a_block():
    ytdl.note_failure("ERROR: [youtube] abc123: Video unavailable")

    s = ytdl.status()
    assert s["blocked"] is False
    assert s["failures"] == 1
    assert "Video unavailable" in s["text"]


def test_the_logger_records_without_the_call_site_remembering_to():
    """Which is the point of putting it in `opts()`: nine call sites don't each
    have to handle this, and a tenth added later gets it for free."""
    logger = ytdl.opts()["logger"]

    logger.error("ERROR: Sign in to confirm you're not a bot")

    assert ytdl.status()["bot_checks"] == 1


def test_a_successful_scan_reads_as_working():
    ytdl.note_success()

    s = ytdl.status()
    assert s["ok"] is True
    assert "Working" in s["text"]


def test_failures_are_still_mentioned_once_something_works():
    """A deployment that fetches most things and is refused for some is a real
    state, and reporting only the good half hides the reason a video won't play."""
    ytdl.note_failure("ERROR: Video unavailable")
    ytdl.note_success()

    text = ytdl.status()["text"]
    assert "Working" in text and "failure" in text


def test_the_status_says_what_it_is_using(monkeypatch):
    """So "still blocked" and "blocked, and it never picked up my cookies" read
    differently."""
    monkeypatch.setattr(env_settings, "youtube_proxy", "http://box:8080")
    runtime_config.invalidate()
    ytdl.note_success()

    assert "using a proxy" in ytdl.status()["text"]


async def test_the_status_endpoint_shapes_it_for_the_settings_page(client):
    """`text` is what the generic StatusLine renders (see app_settings.Spec)."""
    r = await client.get("/api/youtube/extraction-status")

    assert r.status_code == 200
    assert isinstance(r.json()["text"], str) and r.json()["text"]
