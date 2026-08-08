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


# ── where a row came from ────────────────────────────────────────────
#
# The table holds two kinds of row. Pasting a link means "keep this", and those
# are what the Imported page lists. Opening a video with the extension's button
# also needs a row — the watch page and the history reporter read their title,
# channel and stats from it — but that's a cache, not a keepsake.


def test_a_record_is_a_deliberate_import_unless_said_otherwise():
    assert _to_record("vid1", info()).source == "import"


@pytest.mark.asyncio
async def test_a_video_cached_from_youtube_stays_off_the_imported_page(client, db):
    from app.models import ImportedVideo

    db.add(_to_record("kept", info()))
    db.add(_to_record("opened", info(), source="youtube"))
    await db.commit()

    listed = (await client.get("/api/imported")).json()
    assert [v["youtube_id"] for v in listed] == ["kept"]
    # Still stored, though — that's the whole point of writing it.
    assert await db.get(ImportedVideo, "opened") is not None


@pytest.mark.asyncio
async def test_opening_an_unknown_video_resolves_it_from_youtube_and_keeps_it(
    client, db, monkeypatch
):
    """Without this the watch page plays a video under a blank title, and history
    files it nameless."""
    from app.models import ImportedVideo
    from app.routers import imported as imported_mod

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: info(title="Resolved"))

    body = (await client.get("/api/feed/video/never-seen")).json()
    assert body["title"] == "Resolved"
    assert body["channel_name"] == "A Channel"

    rec = await db.get(ImportedVideo, "never-seen")
    assert rec.source == "youtube"


@pytest.mark.asyncio
async def test_a_video_youtube_will_not_give_up_degrades_rather_than_erroring(
    client, monkeypatch
):
    """Private, deleted and region-blocked all land here. The watch page can still
    play from the id alone, so a blank answer beats a 500."""
    from app.routers import imported as imported_mod

    def boom(vid):
        raise RuntimeError("Video unavailable")

    monkeypatch.setattr(imported_mod, "_extract", boom)
    res = await client.get("/api/feed/video/gone")
    assert res.status_code == 200
    assert res.json() == {}


@pytest.mark.asyncio
async def test_the_second_open_is_served_from_the_cached_row(client, monkeypatch):
    """The fetch costs a yt-dlp extraction, so it must happen once per video."""
    from app.routers import imported as imported_mod

    calls = {"n": 0}

    def counted(vid):
        calls["n"] += 1
        return info(title="Once")

    monkeypatch.setattr(imported_mod, "_extract", counted)
    await client.get("/api/feed/video/vid1")
    second = (await client.get("/api/feed/video/vid1")).json()
    assert calls["n"] == 1
    assert second["title"] == "Once"


@pytest.mark.asyncio
async def test_pasting_the_link_of_a_video_you_opened_promotes_it(client, db):
    """Reporting "already imported" about something absent from the Imported page
    would leave no way to actually import it."""
    db.add(_to_record("openedAAAAA", info(), source="youtube"))
    await db.commit()

    res = (await client.post(
        "/api/imported", json={"urls": "https://youtu.be/openedAAAAA"})).json()
    assert [v["youtube_id"] for v in res["added"]] == ["openedAAAAA"]
    assert res["skipped"] == []

    listed = (await client.get("/api/imported")).json()
    assert [v["youtube_id"] for v in listed] == ["openedAAAAA"]


@pytest.mark.asyncio
async def test_pasting_a_link_you_really_did_import_is_still_a_skip(client, db):
    db.add(_to_record("keptAAAAAAA", info()))
    await db.commit()

    res = (await client.post(
        "/api/imported", json={"urls": "https://youtu.be/keptAAAAAAA"})).json()
    assert res["skipped"] == ["keptAAAAAAA"]
    assert res["added"] == []

