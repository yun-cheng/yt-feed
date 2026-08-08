"""The persisted quota ledger, and the 403 that isn't an auth failure."""

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app import quota
from app.youtube_api import _quota_refusal


# ── the quota-day boundary ───────────────────────────────────────────


def test_the_day_turns_over_at_pacific_midnight_not_utc():
    """08:00 UTC is still yesterday in California — a UTC boundary would throw
    away eight hours of allowance, or spend tomorrow's early."""
    assert quota.quota_day(datetime(2026, 8, 8, 6, 0, tzinfo=timezone.utc)) == "2026-08-07"
    assert quota.quota_day(datetime(2026, 8, 8, 8, 0, tzinfo=timezone.utc)) == "2026-08-08"


def test_the_boundary_moves_with_daylight_saving():
    """Pacific is UTC-8 in winter and UTC-7 in summer, so the reset moment in
    UTC is not a fixed hour."""
    assert quota.quota_day(datetime(2026, 1, 8, 7, 30, tzinfo=timezone.utc)) == "2026-01-07"
    assert quota.quota_day(datetime(2026, 1, 8, 8, 30, tzinfo=timezone.utc)) == "2026-01-08"


def test_a_naive_timestamp_is_read_as_utc():
    naive = datetime(2026, 8, 8, 6, 0)
    assert quota.quota_day(naive) == quota.quota_day(naive.replace(tzinfo=timezone.utc))


# ── the ledger ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_an_empty_day_has_spent_nothing():
    assert await quota.spent_today() == (0, 0)


@pytest.mark.asyncio
async def test_spend_accumulates_within_a_day():
    await quota.record(40)
    await quota.record(60)
    assert await quota.spent_today() == (100, 0)


@pytest.mark.asyncio
async def test_archive_spend_is_counted_twice_over():
    """Once against the day, once against the archive's own share — the archive
    is subordinate, so it has to answer to both."""
    await quota.record(100, archive=True)
    assert await quota.spent_today() == (100, 100)


@pytest.mark.asyncio
async def test_a_zero_spend_writes_nothing():
    await quota.record(0)
    assert await quota.spent_today() == (0, 0)


# ── the budget ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_fresh_day_offers_the_archive_its_share():
    assert await quota.archive_budget() == int(quota.DAILY_UNITS * quota.ARCHIVE_SHARE)


@pytest.mark.asyncio
async def test_the_archive_cannot_exceed_its_own_share():
    await quota.record(2000, archive=True)
    assert await quota.archive_budget() == int(quota.DAILY_UNITS * quota.ARCHIVE_SHARE) - 2000


@pytest.mark.asyncio
async def test_essential_work_squeezes_the_archive_out():
    """Nothing the archive is entitled to matters if the day is nearly gone —
    the evening's stale-stats refresh has to find something left."""
    await quota.record(quota.DAILY_UNITS - quota.ESSENTIAL_RESERVE - 50)
    assert await quota.archive_budget() == 50


@pytest.mark.asyncio
async def test_the_budget_never_goes_negative():
    await quota.record(quota.DAILY_UNITS * 2)
    assert await quota.archive_budget() == 0


@pytest.mark.asyncio
async def test_yesterdays_spend_does_not_follow_us_into_today(monkeypatch):
    yesterday = quota.quota_day(datetime.now(timezone.utc) - timedelta(days=1))
    monkeypatch.setattr(quota, "quota_day", lambda now=None: yesterday)
    await quota.record(9_000, archive=True)
    monkeypatch.undo()
    assert await quota.spent_today() == (0, 0)
    assert await quota.archive_budget() == int(quota.DAILY_UNITS * quota.ARCHIVE_SHARE)


# ── telling the two 403s apart ───────────────────────────────────────


def _resp(payload: dict) -> httpx.Response:
    return httpx.Response(403, json=payload, request=httpx.Request("GET", "http://x"))


def test_an_exhausted_allowance_is_recognised():
    assert _quota_refusal(_resp({"error": {"errors": [{"reason": "quotaExceeded"}]}}))
    assert _quota_refusal(_resp({"error": {"errors": [{"reason": "dailyLimitExceeded"}]}}))


def test_a_stale_token_is_not_mistaken_for_an_exhausted_allowance():
    """Both arrive as 403. Answering an auth error by giving up for the day
    would strand the feed; answering a quota error by retrying would spin."""
    assert not _quota_refusal(_resp({"error": {"errors": [{"reason": "authError"}]}}))
    assert not _quota_refusal(_resp({"error": {"errors": [{"reason": "forbidden"}]}}))


def test_an_unreadable_403_is_treated_as_an_auth_problem():
    """The recoverable reading: we retry once and move on, rather than writing
    off the rest of the day on a body we couldn't parse."""
    assert not _quota_refusal(httpx.Response(403, text="<html>nope</html>",
                                             request=httpx.Request("GET", "http://x")))
    assert not _quota_refusal(_resp({}))
