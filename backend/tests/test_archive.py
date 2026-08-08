"""The archive fill: what it walks, in what order, and where it stops."""

from datetime import datetime, timedelta, timezone

import pytest

from app import archive
from app.database import async_session
from app.models import Channel, Video
from app.youtube_api import ARCHIVE_CEILING, QuotaExceeded


async def channel(cid, *, title=None, lifetime=None, cursor=None, exhausted=False):
    async with async_session() as s:
        s.add(Channel(youtube_id=cid, title=title or cid, lifetime_count=lifetime,
                      archive_cursor=cursor, archive_exhausted=exhausted))
        await s.commit()


async def videos(cid, n, *, start_days_ago=0):
    async with async_session() as s:
        for i in range(n):
            s.add(Video(
                youtube_id=f"{cid}-v{i}", channel_id=cid, title=f"v{i}", thumbnail_url="",
                published_at=datetime.utcnow() - timedelta(days=start_days_ago + i),
                duration_seconds=10, view_count=1, like_count=1, is_short=False,
            ))
        await s.commit()


def page(ids, cursor, *, exhausted=False, day=1):
    """A fake uploads page, shaped like fetch_uploads_page's return."""
    return {
        "items": [{"youtube_id": v,
                   "published_at": datetime.now(timezone.utc) - timedelta(days=day)}
                  for v in ids],
        "cursor": cursor,
        "exhausted": exhausted,
    }


# ── ordering ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_channel_owing_least_goes_first():
    """Shortest-job-first: it can't finish the whole sweep sooner, but it makes
    almost all of it finish sooner, which is what a half-done library looks
    like to the person using it."""
    await channel("big", lifetime=8000)
    await channel("small", lifetime=100)
    await channel("mid", lifetime=1000)
    assert [c for c, _ in await archive.channels_by_remaining()] == ["small", "mid", "big"]


@pytest.mark.asyncio
async def test_what_we_already_hold_counts_against_the_remainder():
    await channel("a", lifetime=1000)
    await channel("b", lifetime=200)
    await videos("a", 950)  # 50 left, fewer than b's 200
    assert [c for c, _ in await archive.channels_by_remaining()] == ["a", "b"]


@pytest.mark.asyncio
async def test_a_channel_never_walked_jumps_the_queue():
    """A subscription added today shouldn't wait behind a firehose that's three
    days into its own backlog."""
    await channel("inprogress", lifetime=200, cursor="tok")
    await channel("brand-new", lifetime=9000)
    assert [c for c, _ in await archive.channels_by_remaining()] == ["brand-new", "inprogress"]


@pytest.mark.asyncio
async def test_a_finished_channel_is_not_queued_again():
    await channel("done", lifetime=100, exhausted=True)
    await channel("todo", lifetime=100)
    assert [c for c, _ in await archive.channels_by_remaining()] == ["todo"]


@pytest.mark.asyncio
async def test_a_channel_with_no_known_lifetime_is_still_queued():
    """Unknown means the count lookup hasn't run yet — assume there's work,
    rather than skipping the channel forever on missing data."""
    await channel("unknown")
    assert [c for c, _ in await archive.channels_by_remaining()] == ["unknown"]


# ── the walk ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_walk_stores_what_it_finds_and_remembers_where_it_stopped(monkeypatch):
    await channel("c", lifetime=100)
    monkeypatch.setattr(archive, "fetch_uploads_page",
                        lambda cid, cursor, pages: page(["v1", "v2"], "next-token"))
    result = await archive.fill_channel("c", budget_units=1)

    assert result["added"] == 2
    async with async_session() as s:
        assert (await s.get(Channel, "c")).archive_cursor == "next-token"
        assert (await s.get(Video, "v1")).channel_id == "c"


@pytest.mark.asyncio
async def test_a_walk_resumes_from_the_stored_cursor(monkeypatch):
    """The whole design rests on this: a page token is self-contained, so the
    fill can span processes and days without re-walking what it already has."""
    await channel("c", lifetime=100, cursor="where-i-left-off")
    seen = {}

    def fake(cid, cursor, pages):
        seen["cursor"] = cursor
        return page(["v9"], None, exhausted=True)

    monkeypatch.setattr(archive, "fetch_uploads_page", fake)
    await archive.fill_channel("c", budget_units=1)
    assert seen["cursor"] == "where-i-left-off"


@pytest.mark.asyncio
async def test_running_out_of_pages_marks_the_channel_complete(monkeypatch):
    await channel("c", lifetime=100)
    monkeypatch.setattr(archive, "fetch_uploads_page",
                        lambda cid, cursor, pages: page(["v1"], None, exhausted=True))
    result = await archive.fill_channel("c", budget_units=10)

    assert result["stopped"] == "exhausted"
    async with async_session() as s:
        assert (await s.get(Channel, "c")).archive_exhausted is True


@pytest.mark.asyncio
async def test_a_video_we_already_hold_is_not_inserted_twice(monkeypatch):
    await channel("c", lifetime=100)
    await videos("c", 1)  # inserts c-v0
    monkeypatch.setattr(archive, "fetch_uploads_page",
                        lambda cid, cursor, pages: page(["c-v0", "fresh"], None, exhausted=True))
    result = await archive.fill_channel("c", budget_units=10)
    assert result["added"] == 1
    assert result["new_ids"] == ["fresh"]


@pytest.mark.asyncio
async def test_the_walk_stops_when_the_budget_is_gone(monkeypatch):
    """An endless playlist must not become an endless walk."""
    calls = {"n": 0}

    def fake(cid, cursor, pages):
        calls["n"] += 1
        return page([f"v{calls['n']}"], f"tok{calls['n']}")

    await channel("c", lifetime=100_000)
    monkeypatch.setattr(archive, "fetch_uploads_page", fake)

    result = await archive.fill_channel("c", budget_units=archive.PAGES_PER_STEP * 2)
    assert result["stopped"] == "budget"
    assert calls["n"] == 2  # two steps' worth of pages, then stop


@pytest.mark.asyncio
async def test_the_budget_is_counted_in_pages_not_in_what_the_meter_says(monkeypatch):
    """The stopping condition can't be a measurement. If the spend counter ever
    read zero — a bug, a reset, a mocked client — a spend-driven loop would walk
    the playlist forever."""
    calls = {"n": 0}

    def fake(cid, cursor, pages):
        calls["n"] += 1
        return page([f"v{calls['n']}"], f"tok{calls['n']}")

    await channel("c", lifetime=100_000)
    monkeypatch.setattr(archive, "fetch_uploads_page", fake)
    monkeypatch.setattr(archive, "take_quota_delta", lambda: 0)  # meter stuck at zero

    result = await archive.fill_channel("c", budget_units=archive.PAGES_PER_STEP)
    assert calls["n"] == 1
    assert result["pages"] == archive.PAGES_PER_STEP


@pytest.mark.asyncio
async def test_a_refused_allowance_stops_the_walk_rather_than_retrying(monkeypatch):
    def refuse(cid, cursor, pages):
        raise QuotaExceeded("out of units")

    await channel("c", lifetime=100)
    monkeypatch.setattr(archive, "fetch_uploads_page", refuse)
    result = await archive.fill_channel("c", budget_units=100)
    assert result["stopped"] == "quota"
    assert result["added"] == 0


# ── progress ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_counting_the_library_does_not_eat_the_fetching_budget(monkeypatch):
    """The lifetime lookup is the readout, not the fill — it runs whether or not
    the sweep is switched on, so charging it to the archive's share would let
    opening a channel page spend what the fetching needs."""
    from app import quota

    await channel("c")
    monkeypatch.setattr(archive, "fetch_channel_video_counts", lambda ids: {"c": 500})
    monkeypatch.setattr(archive, "take_quota_delta", lambda: 1)

    await archive.refresh_lifetime_counts(["c"])
    assert await quota.spent_today() == (1, 0)


@pytest.mark.asyncio
async def test_progress_reports_what_is_reachable_not_what_exists():
    """The uploads playlist stops at 20,000 however many videos a channel really
    has, so a progress bar against the true count would never fill."""
    await channel("huge", lifetime=40_097)
    await videos("huge", 10)
    async with async_session() as s:
        p = await archive.channel_progress(s, await s.get(Channel, "huge"))
    assert p["lifetime"] == 40_097
    assert p["reachable"] == ARCHIVE_CEILING
    assert p["remaining"] == ARCHIVE_CEILING - 10
    assert p["capped_by_api"] is True


@pytest.mark.asyncio
async def test_progress_names_the_oldest_video_held():
    """The date coverage is derived, never configured — which is what lets the
    slider's question ("do I have 6m–1y?") be answered by a count-based fill."""
    await channel("c", lifetime=100)
    await videos("c", 3, start_days_ago=400)
    async with async_session() as s:
        p = await archive.channel_progress(s, await s.get(Channel, "c"))
    assert p["held"] == 3
    assert p["oldest_held"].startswith(str((datetime.utcnow() - timedelta(days=402)).year))
