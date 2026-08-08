"""
The YouTube Data API quota, as a thing we can budget against.

`youtube_api` counts units in memory as it spends them, which is enough to print
at the end of a run but useless as a budget: it zeroes on every process restart,
so a crash mid-sweep would look like a fresh allowance. This module persists the
spend per **quota-day** and answers the only question the archive fill needs —
"how much may I spend right now?".

Two things are easy to get wrong here and both are load-bearing:

- **The day boundary is midnight US/Pacific**, not UTC and not local. Get it
  wrong and you either throw away hours of allowance or blow through the reset.
- **The archive is subordinate.** Keeping the feed fresh (stats for new videos,
  the stale refresh) always outranks fetching a channel's back catalogue, so the
  archive gets a cap of its own AND has to leave a reserve untouched for the
  essential work that hasn't run yet today.
"""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app.database import async_session
from app.models import QuotaLedger

# YouTube resets the quota at midnight Pacific.
PACIFIC = ZoneInfo("America/Los_Angeles")

# A default Data API project allowance. Not discoverable through the API, so
# it's a constant we budget conservatively against rather than a measurement.
DAILY_UNITS = 10_000

# The archive fill may spend at most this share of a day's allowance...
ARCHIVE_SHARE = 0.25

# ...and must always leave this much untouched, whatever its own cap says, so
# the evening's stale-stats refresh never finds the cupboard bare. Measured at
# ~335 units/day of essential work, so this is roughly triple the headroom.
ESSENTIAL_RESERVE = 1_000


def quota_day(now: datetime | None = None) -> str:
    """The YouTube quota-day a moment belongs to, as an ISO date string."""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(PACIFIC).date().isoformat()


async def record(units: int, *, archive: bool = False) -> None:
    """Add units to today's ledger. `archive` also charges the archive's cap."""
    if units <= 0:
        return
    day = quota_day()
    async with async_session() as session:
        row = (await session.execute(
            select(QuotaLedger).where(QuotaLedger.quota_day == day)
        )).scalar_one_or_none()
        if row is None:
            row = QuotaLedger(quota_day=day, units=0, archive_units=0)
            session.add(row)
        row.units = (row.units or 0) + units
        if archive:
            row.archive_units = (row.archive_units or 0) + units
        await session.commit()


async def spent_today() -> tuple[int, int]:
    """(total units, archive units) spent in the current quota-day."""
    async with async_session() as session:
        row = (await session.execute(
            select(QuotaLedger).where(QuotaLedger.quota_day == quota_day())
        )).scalar_one_or_none()
    return (row.units or 0, row.archive_units or 0) if row else (0, 0)


async def archive_budget() -> int:
    """Units the archive fill may still spend today. Never negative."""
    total, archive = await spent_today()
    own_cap = int(DAILY_UNITS * ARCHIVE_SHARE) - archive
    day_left = DAILY_UNITS - ESSENTIAL_RESERVE - total
    return max(0, min(own_cap, day_left))
