"""Which of a channel's tabs the scan reads, and what it keeps from them.

YouTube files a channel's uploads under three tabs — Videos, Shorts and Live —
and a video on one is on no other. A tab the scan doesn't ask for is a kind of
video the feed never has: live streams went missing that way for months.
"""

import pytest

from app import cron_update, fetcher, ytdl
from app.models import Channel


@pytest.fixture(autouse=True)
def clean():
    """The recorder's tally is module state; each case starts from none."""
    ytdl.reset()
    yield
    ytdl.reset()


async def test_the_scan_asks_every_channel_for_all_three_tabs(monkeypatch):
    asked: list[str] = []

    def fake_fetch(url, max_results=50, since=None, detailed=True, tab="videos"):
        asked.append(tab)
        return []

    monkeypatch.setattr(cron_update, "fetch_latest_videos", fake_fetch)
    await cron_update.scan_channel_videos(Channel(youtube_id="UCx", title="x"))

    assert asked == ["videos", "shorts", "streams"]


def _entries(monkeypatch, *entries):
    monkeypatch.setattr(fetcher, "_run_ytdlp", lambda url, **opts: list(entries))


def test_a_scheduled_stream_waits_until_it_goes_live(monkeypatch):
    """Nothing to play, no start and no length: in the feed it would be a card
    that opens onto a countdown, dated whenever the scan happened to see it."""
    _entries(
        monkeypatch,
        {"id": "upcoming001", "title": "Tomorrow", "live_status": "is_upcoming"},
        {"id": "onair000001", "title": "Now", "live_status": "is_live"},
        {"id": "recorded001", "title": "Yesterday", "live_status": "was_live", "duration": 11148},
    )

    got = fetcher.fetch_latest_videos("https://www.youtube.com/channel/UCx", tab="streams")

    assert [v["youtube_id"] for v in got] == ["onair000001", "recorded001"]
    assert all(v["is_short"] is False for v in got)
    assert got[1]["duration_seconds"] == 11148


@pytest.mark.parametrize("tab", ["shorts", "streams"])
def test_a_channel_without_the_tab_is_not_a_failure(tab):
    """Most channels have no Live tab and many no Shorts. Counted, that would be
    a failure per channel per scan on the Settings health line, burying the
    ones that mean something."""
    ytdl.opts()["logger"].error(f"ERROR: [youtube:tab] UCx: This channel does not have a {tab} tab")

    assert ytdl.status()["failures"] == 0


def test_a_real_failure_on_the_same_call_still_counts():
    ytdl.opts()["logger"].error("ERROR: [youtube:tab] UCx: This channel does not exist")

    assert ytdl.status()["failures"] == 1
