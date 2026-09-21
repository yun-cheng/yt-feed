"""The pure parsers on the YouTube ingest boundary.

`youtube_api` and `cron_update` are mostly HTTP, and mostly not worth faking.
But a few functions in them are plain data transforms standing between somebody
else's JSON and our database, and those are worth pinning: when one of them is
wrong the app doesn't fail, it stores something subtly untrue and shows it to
you as fact.
"""

from datetime import datetime, timezone

import pytest

from app.cron_update import _publication_time
from app.youtube_api import _parse_iso8601_duration, _quota_refusal, _thumb


# ── Durations ────────────────────────────────────────────────────────
#
# `duration_seconds` is what the length filter buckets on, so a parse that
# quietly returns 0 doesn't just mislabel a video — it files it under "under 5
# minutes" and hands it to you when you asked for something short.


@pytest.mark.parametrize(
    "iso,seconds",
    [
        ("PT1H2M3S", 3723),
        ("PT45S", 45),
        ("PT10M", 600),
        ("PT2H30M", 9000),
        ("PT0S", 0),
    ],
)
def test_the_ordinary_video_lengths(iso, seconds):
    assert _parse_iso8601_duration(iso) == seconds


@pytest.mark.parametrize(
    "iso,seconds",
    [
        ("P1D", 86_400),
        ("P1DT2H", 93_600),
        ("P2DT3H4M5S", 183_845),
    ],
)
def test_a_stream_long_enough_to_carry_a_day_component(iso, seconds):
    """Past 24 hours YouTube switches to `P1DT2H…`, which a time-only pattern
    matches as far as the `P` and reads as zero — so the longest videos in the
    feed were the ones filed as having no length at all."""
    assert _parse_iso8601_duration(iso) == seconds


@pytest.mark.parametrize("bad", ["", "garbage", "1h2m", "PT", "P"])
def test_anything_unparseable_is_zero_rather_than_an_exception(bad):
    """This runs inside the scan, over a page of videos at a time: one odd
    string must cost that video its length, not the whole batch."""
    assert _parse_iso8601_duration(bad) == 0


# ── Thumbnails ───────────────────────────────────────────────────────


def test_thumb_prefers_the_biggest_it_was_offered():
    thumbs = {
        "default": {"url": "small.jpg"},
        "medium": {"url": "medium.jpg"},
        "maxres": {"url": "huge.jpg"},
    }
    assert _thumb(thumbs) == "huge.jpg"


def test_thumb_falls_down_the_ladder_when_the_big_sizes_are_missing():
    """Most videos have no `maxres`, and a lot have no `standard` — the ladder
    is the point, not the first entry in it."""
    assert _thumb({"default": {"url": "small.jpg"}}) == "small.jpg"
    assert _thumb({"high": {"url": "h.jpg"}, "default": {"url": "d.jpg"}}) == "h.jpg"


def test_thumb_of_nothing_is_the_empty_string():
    """A card renders it into `src` either way, so None would be the string
    "None" pointed at the server."""
    assert _thumb({}) == ""
    assert _thumb({"default": {}}) == ""
    assert _thumb({"default": None}) == ""


# ── Telling a spent quota from a dead token ──────────────────────────
#
# Both arrive as a 403 and they need opposite responses: wait until tomorrow,
# versus go and re-authenticate. Reading one as the other either nags you to
# re-auth a token that is fine, or leaves the app quietly broken until you
# notice nothing has updated.


def test_a_403_about_the_allowance_reads_as_quota():
    class Resp:
        def json(self):
            return {"error": {"errors": [{"reason": "quotaExceeded"}]}}

    assert _quota_refusal(Resp()) is True


def test_a_403_about_the_credentials_does_not():
    class Resp:
        def json(self):
            return {"error": {"errors": [{"reason": "authError"}]}}

    assert _quota_refusal(Resp()) is False


def test_a_403_whose_body_is_not_json_is_not_a_quota_refusal():
    """Google's error bodies are usually JSON; a proxy or an outage page in the
    way is exactly when guessing "quota" would hide a real failure."""

    class Resp:
        def json(self):
            raise ValueError("not json")

    assert _quota_refusal(Resp()) is False


# ── Publication times off a yt-dlp entry ─────────────────────────────


def test_a_unix_timestamp_becomes_an_aware_utc_datetime():
    """Naive datetimes compare unequal against the aware ones the rest of the
    ingest uses, and the feed is sorted by this column."""
    at = _publication_time({"timestamp": 1_700_000_000})
    assert at == datetime(2023, 11, 14, 22, 13, 20, tzinfo=timezone.utc)
    assert at.tzinfo is not None


def test_published_at_wins_over_the_timestamp_field():
    assert _publication_time(
        {"published_at": 1_700_000_000, "timestamp": 1}
    ) == datetime(2023, 11, 14, 22, 13, 20, tzinfo=timezone.utc)


def test_an_entry_with_no_time_falls_back_to_now_rather_than_the_epoch():
    """flat-mode entries often carry no date. Filing them at 1970 would drop
    them off the end of every time window instead of showing them as new."""
    before = datetime.now(timezone.utc)
    at = _publication_time({})
    assert before <= at <= datetime.now(timezone.utc)
