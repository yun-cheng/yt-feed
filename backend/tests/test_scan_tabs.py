"""A channel with no Shorts or no Live tab, as the extraction status sees it.

The scan asks every channel for each tab, every pass, and yt-dlp answers a tab
that isn't there with an error. That's an answer about the channel, not a sign
that extraction is failing.
"""

import pytest

from app import ytdl


@pytest.fixture(autouse=True)
def clean():
    """The recorder's tally is module state; each case starts from none."""
    ytdl.reset()
    yield
    ytdl.reset()


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
