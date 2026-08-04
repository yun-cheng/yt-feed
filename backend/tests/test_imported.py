"""Imported videos — one-offs pasted in by URL.

The yt-dlp extraction is stubbed; what's tested is the parsing around it and the
record it builds, which is what the card renders.
"""

from datetime import datetime, timezone

import pytest

from app.routers.imported import _published_at, _to_record, parse_video_ids


# ── parse_video_ids: what the paste box accepts ──────────────────────


@pytest.mark.parametrize(
    "raw",
    [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ",
        "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
        "https://www.youtube.com/shorts/dQw4w9WgXcQ",
        "https://www.youtube.com/embed/dQw4w9WgXcQ",
        "dQw4w9WgXcQ",  # a bare id
    ],
)
def test_every_link_shape_yields_the_id(raw):
    ids, bad = parse_video_ids(raw)
    assert ids == ["dQw4w9WgXcQ"]
    assert bad == []


def test_several_links_on_one_line_and_one_per_line_both_work():
    ids, bad = parse_video_ids(
        "https://youtu.be/aaaaaaaaaaa https://youtu.be/bbbbbbbbbbb\nhttps://youtu.be/ccccccccccc"
    )
    assert ids == ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]
    assert bad == []


def test_duplicates_within_one_paste_collapse_to_the_first():
    ids, _bad = parse_video_ids(
        "https://youtu.be/dQw4w9WgXcQ https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    )
    assert ids == ["dQw4w9WgXcQ"]


def test_non_youtube_tokens_are_reported_rather_than_dropped():
    """The dialog tells you which lines it couldn't read, so a typo in a list of
    thirty doesn't silently import twenty-nine."""
    ids, bad = parse_video_ids("https://youtu.be/dQw4w9WgXcQ https://example.com/video notaurl")
    assert ids == ["dQw4w9WgXcQ"]
    assert bad == ["https://example.com/video", "notaurl"]


def test_an_empty_paste_is_empty():
    assert parse_video_ids("") == ([], [])
    assert parse_video_ids("   \n  ") == ([], [])


# ── _published_at: three sources, in order of trust ──────────────────


def test_published_at_prefers_the_exact_timestamp():
    ts = int(datetime(2026, 1, 2, 3, 4, tzinfo=timezone.utc).timestamp())
    assert _published_at({"timestamp": ts}) == datetime(2026, 1, 2, 3, 4)


def test_published_at_falls_back_to_the_upload_date():
    assert _published_at({"upload_date": "20260102"}) == datetime(2026, 1, 2)


def test_published_at_is_naive_utc_like_the_db_stores_it():
    """An aware datetime here would raise the moment ranking subtracted it."""
    ts = int(datetime(2026, 1, 2, 3, 4, tzinfo=timezone.utc).timestamp())
    assert _published_at({"timestamp": ts}).tzinfo is None


def test_published_at_of_a_malformed_date_falls_through_to_now():
    assert (datetime.utcnow() - _published_at({"upload_date": "not-a-date"})).total_seconds() < 5
    assert (datetime.utcnow() - _published_at({})).total_seconds() < 5


# ── _to_record: the snapshot a card renders ──────────────────────────


def info(**over):
    base = {
        "title": "A Video",
        "channel_id": "chan1",
        "channel": "A Channel",
        "thumbnail": "https://example.test/t.jpg",
        "duration": 300,
        "view_count": 1000,
        "like_count": 100,
        "width": 1920,
        "height": 1080,
        "upload_date": "20260102",
    }
    return {**base, **over}


def test_record_carries_the_metadata():
    r = _to_record("vid1", info())
    assert r.youtube_id == "vid1"
    assert r.title == "A Video"
    assert r.channel_name == "A Channel"
    assert r.view_count == 1000
    assert r.duration_seconds == 300
    assert r.score > 0
    assert r.created_at is not None  # set here, not left to the column default


def test_missing_fields_fall_back_rather_than_crash():
    r = _to_record("vid1", {})
    assert r.title == ""
    assert r.view_count == 0
    assert r.thumbnail_url == "https://i.ytimg.com/vi/vid1/hqdefault.jpg"


def test_uploader_stands_in_for_channel():
    r = _to_record("vid1", info(channel=None, channel_id=None, uploader="Someone", uploader_id="u1"))
    assert r.channel_name == "Someone"
    assert r.channel_id == "u1"


@pytest.mark.parametrize(
    "width,height,duration,expected",
    [
        (1080, 1920, 45, True),    # portrait and short
        (1920, 1080, 45, False),   # landscape
        (1080, 1920, 300, False),  # portrait but past the 180s ceiling
        (1080, 1920, 180, True),   # exactly at the ceiling
        (1080, 1920, 0, False),    # unknown duration isn't a Short
        (0, 0, 45, False),         # unknown dimensions
    ],
)
def test_shorts_are_inferred_from_shape_and_length(width, height, duration, expected):
    """yt-dlp doesn't flag Shorts, so the format has to be read off the video."""
    r = _to_record("vid1", info(width=width, height=height, duration=duration))
    assert r.is_short is expected


def test_channel_avatar_is_picked_out_of_the_thumbnail_list():
    r = _to_record("vid1", info(thumbnails=[
        {"id": "0", "url": "https://example.test/frame.jpg"},
        {"id": "avatar_uncropped", "url": "https://example.test/avatar.jpg"},
    ]))
    assert r.channel_thumbnail == "https://example.test/avatar.jpg"


def test_no_avatar_in_the_extraction_is_blank_not_an_error():
    assert _to_record("vid1", info()).channel_thumbnail == ""
