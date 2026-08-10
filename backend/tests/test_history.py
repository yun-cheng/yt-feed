"""Watch history — where you got to, and whether you finished."""

import pytest

from app.routers.history import (
    MIN_POSITION_SECONDS,
    WATCHED_RATIO,
    WATCHED_TAIL_SECONDS,
    is_watched,
)


# ── is_watched: the rule the whole feature turns on ──────────────────


@pytest.mark.parametrize(
    "position,duration,expected",
    [
        # Unknown duration can never count as finished — a video we only ever saw
        # through a snapshot reports 0, and 0 * 0.9 would make every position pass.
        (0, 0, False),
        (5000, 0, False),
        # The 90% rule, which is what decides every video over ten minutes.
        (1620 - 1, 1800, False),
        (1620, 1800, True),
        (3 * 3600 * WATCHED_RATIO, 3 * 3600, True),
        (0, 1800, False),
        # The tail rule, which decides everything UNDER ten minutes: at five
        # minutes, 90% is 4:30 but the last minute starts at 4:00, so 4:10
        # counts as finished even though the ratio says otherwise.
        (250, 300, True),
        (239, 300, False),
    ],
)
def test_is_watched(position, duration, expected):
    assert is_watched(position, duration) is expected


def test_the_two_rules_cross_over_at_ten_minutes():
    """Whichever fires first decides, and which one that is depends on length.

    Worth pinning down because the constant's comment has it backwards: it says
    the tail covers LONG videos, but 0.9 * d is earlier than d - 60 for anything
    over 10 minutes, so the tail only ever adds coverage BELOW that.
    """
    crossover = WATCHED_TAIL_SECONDS / (1 - WATCHED_RATIO)
    assert round(crossover) == 600
    # Well under: the tail fires first, so a position the ratio rejects passes.
    assert 250 < 300 * WATCHED_RATIO
    assert is_watched(250, 300) is True
    # Well over: the ratio fires first, and the tail never gets a say — 1620s of
    # a half-hour video is finished, though the last minute is still 2 minutes off.
    assert 1620 < 1800 - WATCHED_TAIL_SECONDS
    assert is_watched(1620, 1800) is True


# ── The endpoint ─────────────────────────────────────────────────────


async def report(client, youtube_id="vid1", position=100.0, duration=600, **extra):
    payload = {
        "youtube_id": youtube_id,
        "position_seconds": position,
        "duration_seconds": duration,
        **extra,
    }
    r = await client.post("/api/history", json=payload)
    assert r.status_code == 200, r.text
    return r.json()


async def test_unwatched_video_returns_empty_object(client):
    """`{}` rather than a 404 — the watch page asks about every video it opens
    and "never watched" is the ordinary answer, not an error."""
    r = await client.get("/api/history/vid1")
    assert r.status_code == 200
    assert r.json() == {}


async def test_a_glancing_open_is_not_recorded(client):
    """Below the threshold nothing is written at all, so a misclick doesn't
    put a video in History."""
    assert (await report(client, position=MIN_POSITION_SECONDS - 1))["status"] == "ignored"
    assert (await client.get("/api/history/vid1")).json() == {}
    assert (await client.get("/api/history")).json() == []


async def test_progress_is_upserted_not_appended(client):
    await report(client, position=100.0)
    await report(client, position=250.0)
    assert len((await client.get("/api/history")).json()) == 1
    assert (await client.get("/api/history/vid1")).json()["position_seconds"] == 250.0


async def test_reaching_the_end_marks_it_watched(client):
    out = await report(client, position=595.0, duration=600)
    assert out["watched"] is True
    assert (await client.get("/api/history/vid1")).json()["watched"] is True


async def test_watched_is_sticky_across_a_rewatch(client):
    """Finishing once is enough; restarting and stopping halfway must not
    un-finish the video."""
    await report(client, position=595.0, duration=600)
    await report(client, position=30.0, duration=600)
    row = (await client.get("/api/history/vid1")).json()
    assert row["watched"] is True
    assert row["position_seconds"] == 30.0  # resume still follows the latest ping


async def test_metadata_snapshot_is_stored_and_returned(client):
    """The History page renders a card from this, for videos that have since
    aged out of the feed."""
    await report(
        client,
        title="A Video",
        channel_id="chan1",
        channel_name="A Channel",
        channel_thumbnail="https://example.test/avatar.jpg",
        thumbnail_url="https://example.test/thumb.jpg",
        published_at="2026-01-01T00:00:00",
        view_count=1234,
        like_count=56,
        is_short=True,
        score=7.5,
    )
    row = (await client.get("/api/history/vid1")).json()
    assert row["title"] == "A Video"
    assert row["channel_name"] == "A Channel"
    assert row["view_count"] == 1234
    assert row["is_short"] is True
    assert row["score"] == 7.5
    assert row["watched_at"]


async def test_a_bare_ping_does_not_blank_an_existing_snapshot(client):
    """A progress ping sent before the watch page resolved its metadata carries
    no title — writing it through would wipe the row the History page reads."""
    await report(client, title="A Video", channel_name="A Channel")
    await report(client, position=200.0)  # no metadata in this one
    row = (await client.get("/api/history/vid1")).json()
    assert row["title"] == "A Video"
    assert row["channel_name"] == "A Channel"
    assert row["position_seconds"] == 200.0


async def test_duration_zero_does_not_erase_a_known_duration(client):
    await report(client, duration=600)
    await report(client, position=200.0, duration=0)
    assert (await client.get("/api/history/vid1")).json()["duration_seconds"] == 600


async def test_list_is_most_recently_watched_first(client):
    await report(client, youtube_id="first")
    await report(client, youtube_id="second")
    await report(client, youtube_id="third")
    ids = [h["youtube_id"] for h in (await client.get("/api/history")).json()]
    assert ids[0] == "third"
    assert set(ids) == {"first", "second", "third"}


async def test_delete_removes_one_video_from_history(client):
    await report(client, youtube_id="keep")
    await report(client, youtube_id="drop")
    assert (await client.delete("/api/history/drop")).status_code == 200
    ids = [h["youtube_id"] for h in (await client.get("/api/history")).json()]
    assert ids == ["keep"]


async def test_delete_of_unwatched_video_is_not_an_error(client):
    assert (await client.delete("/api/history/never-watched")).status_code == 200


# ── Reporting with nothing but an id ─────────────────────────
#
# What the extension posts while you watch on youtube.com: it has the play head
# and the video id, and the metadata is resolved on this side.


def _info(**over):
    return {
        "title": "A Video", "channel": "A Channel", "channel_id": "chan1",
        "view_count": 1000, "like_count": 10, "duration": 300,
        "upload_date": "20260102", **over,
    }


async def report_by_id(client, youtube_id="vid1", position=100.0, duration=600):
    r = await client.post(
        f"/api/history/by-id/{youtube_id}",
        json={"position_seconds": position, "duration_seconds": duration},
    )
    assert r.status_code == 200, r.text
    return r.json()


async def test_reporting_by_id_fills_the_snapshot_in(client, monkeypatch):
    from app.routers import imported as imported_mod

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: _info())

    await report_by_id(client, "openedAAAAA")
    row = (await client.get("/api/history/openedAAAAA")).json()
    assert (row["title"], row["channel_name"]) == ("A Video", "A Channel")
    assert row["position_seconds"] == 100.0


async def test_a_video_we_already_hold_costs_no_extraction(client, db, monkeypatch):
    """A subscribed channel's video is already a row — reporting progress on it
    must not go to YouTube for what's sitting in the database."""
    from datetime import datetime

    from app.models import Channel, Video
    from app.routers import imported as imported_mod

    def unexpected(vid):
        raise AssertionError("went to YouTube for a video we already have")

    monkeypatch.setattr(imported_mod, "_extract", unexpected)

    db.add(Channel(youtube_id="chan1", title="A Channel"))
    db.add(Video(
        youtube_id="knownAAAAAA", channel_id="chan1", title="Known",
        published_at=datetime(2026, 1, 2), view_count=500, duration_seconds=120,
    ))
    await db.commit()

    await report_by_id(client, "knownAAAAAA", duration=120)
    row = (await client.get("/api/history/knownAAAAAA")).json()
    assert (row["title"], row["channel_id"]) == ("Known", "chan1")


async def test_the_snapshot_is_resolved_once_not_every_ten_seconds(client, monkeypatch):
    """This fires for as long as the video plays. Once the row has a title
    there's nothing left to look up, and looking anyway would put a lookup on a
    path that runs every ten seconds forever."""
    from app.routers import imported as imported_mod

    calls = []

    def counted(vid):
        calls.append(vid)
        return _info()

    monkeypatch.setattr(imported_mod, "_extract", counted)

    await report_by_id(client, "openedAAAAA", position=100.0)
    await report_by_id(client, "openedAAAAA", position=110.0)
    await report_by_id(client, "openedAAAAA", position=120.0)
    assert calls == ["openedAAAAA"]
    assert (await client.get("/api/history/openedAAAAA")).json()["position_seconds"] == 120.0


async def test_a_glancing_open_resolves_nothing(client, monkeypatch):
    """Below the threshold there's no row to fill, so the lookup mustn't run
    either — an ad or a misclick would otherwise cost a YouTube fetch."""
    from app.routers import imported as imported_mod

    def unexpected(vid):
        raise AssertionError("resolved a video that was never really watched")

    monkeypatch.setattr(imported_mod, "_extract", unexpected)

    out = await report_by_id(client, position=MIN_POSITION_SECONDS - 1)
    assert out["status"] == "ignored"
    assert (await client.get("/api/history")).json() == []


async def test_the_players_duration_beats_the_resolved_one(client, monkeypatch):
    """The player is watching the actual video; the feed's copy can be stale or
    missing. `is_watched` turns on this number, so which one wins matters."""
    from app.routers import imported as imported_mod

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: _info(duration=300))

    await report_by_id(client, "openedAAAAA", position=100.0, duration=600)
    assert (await client.get("/api/history/openedAAAAA")).json()["duration_seconds"] == 600


async def test_a_player_with_no_duration_falls_back_to_the_resolved_one(client, monkeypatch):
    from app.routers import imported as imported_mod

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: _info(duration=300))

    await report_by_id(client, "openedAAAAA", position=100.0, duration=0)
    assert (await client.get("/api/history/openedAAAAA")).json()["duration_seconds"] == 300


async def test_the_switch_refuses_a_report_and_resolves_nothing(client, monkeypatch):
    """The extension holds the setting for up to a minute, so a report already
    on its way when you turn it off has to be refused here. Checked before the
    lookup, or turning it off would still cost a YouTube fetch."""
    from app import app_settings
    from app.routers import imported as imported_mod

    def unexpected(vid):
        raise AssertionError("resolved a video for a report we don't want")

    monkeypatch.setattr(imported_mod, "_extract", unexpected)
    await app_settings.put({"youtube_history_sync": False})

    out = await report_by_id(client, "openedAAAAA", position=100.0)
    assert out == {"status": "off"}
    assert (await client.get("/api/history")).json() == []


async def test_the_switch_leaves_the_app_s_own_reporting_alone(client):
    """It's about the extension. Watching in the app is not what it governs, and
    a shared endpoint would be an easy way to turn off more than was asked."""
    from app import app_settings

    await app_settings.put({"youtube_history_sync": False})

    await report(client, position=100.0)
    assert (await client.get("/api/history/vid1")).json()["position_seconds"] == 100.0


async def test_watching_on_youtube_and_in_the_app_is_one_row(client, monkeypatch):
    """Both sides write the same history, and the later position wins — which is
    what makes resuming in one place follow the other."""
    from app.routers import imported as imported_mod

    monkeypatch.setattr(imported_mod, "_extract", lambda vid: _info())

    await report_by_id(client, "openedAAAAA", position=100.0)
    await report(client, youtube_id="openedAAAAA", position=400.0, title="A Video")
    assert len((await client.get("/api/history")).json()) == 1
    assert (await client.get("/api/history/openedAAAAA")).json()["position_seconds"] == 400.0
