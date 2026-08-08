"""
App settings: the switches that belong to *you*, not to the deployment.

`config.py` (`.env`) is for secrets and environment wiring — API keys, ports,
paths. Those are properties of where the app runs. This module is for the other
kind: preferences about how the app behaves, which should be changeable from the
app itself rather than by editing a file and restarting a server. A switch that
governs an unattended background job especially: turning it *on* deserves to be
deliberate, but turning it *off* has to be immediate, and "edit .env, restart
uvicorn" is the wrong shape for a kill switch.

Adding a setting is one entry in SPEC. The API serves the spec alongside the
values and the settings page renders itself from it, so nothing else has to
change — no endpoint, no form field, no frontend type.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from sqlalchemy import select

from app.config import settings as env_settings
from app.database import async_session
from app.models import AppSetting


@dataclass(frozen=True)
class Spec:
    key: str
    type: str  # "bool" — more as they're needed; the UI switches on this
    default: Callable[[], Any]
    label: str
    description: str
    group: str
    # Optional API path returning {"text": "..."} — a live line rendered under
    # the description. Generic on purpose: a setting whose cost or progress the
    # user should see before deciding can say so without the page learning
    # anything about that particular setting.
    status: str = ""


SPEC: tuple[Spec, ...] = (
    Spec(
        key="archive_fill_enabled",
        type="bool",
        # The .env value is a BOOTSTRAP default, not a second source of truth:
        # it seeds the first read and is ignored once the setting is stored.
        default=lambda: env_settings.archive_fill_enabled,
        label="Fill channel history automatically",
        description=(
            "Fetch every channel's older videos in the background, a little each "
            "day, until nothing is left to fetch. Uses at most a quarter of the "
            "daily YouTube API quota and never touches what the feed needs. "
            "A large library takes a few days. Off, you can still fetch any "
            "channel's history yourself from its page."
        ),
        group="Library",
        status="/api/channels/archive/summary",
    ),
)

_BY_KEY = {s.key: s for s in SPEC}


def _decode(spec: Spec, raw: str) -> Any:
    if spec.type == "bool":
        return raw == "1"
    return raw


def _encode(spec: Spec, value: Any) -> str:
    if spec.type == "bool":
        return "1" if value else "0"
    return str(value)


async def get(key: str) -> Any:
    """One setting's value, falling back to its bootstrap default."""
    spec = _BY_KEY[key]
    async with async_session() as session:
        row = (await session.execute(
            select(AppSetting).where(AppSetting.key == key)
        )).scalar_one_or_none()
    return _decode(spec, row.value) if row else spec.default()


async def all_values() -> dict[str, Any]:
    async with async_session() as session:
        stored = {
            r.key: r.value for r in
            (await session.execute(select(AppSetting))).scalars().all()
        }
    return {
        s.key: _decode(s, stored[s.key]) if s.key in stored else s.default()
        for s in SPEC
    }


async def put(updates: dict[str, Any]) -> dict[str, Any]:
    """Store some settings. Unknown keys raise rather than being swallowed."""
    unknown = set(updates) - set(_BY_KEY)
    if unknown:
        raise KeyError(f"unknown setting(s): {', '.join(sorted(unknown))}")

    async with async_session() as session:
        for key, value in updates.items():
            spec = _BY_KEY[key]
            row = (await session.execute(
                select(AppSetting).where(AppSetting.key == key)
            )).scalar_one_or_none()
            if row is None:
                session.add(AppSetting(key=key, value=_encode(spec, value)))
            else:
                row.value = _encode(spec, value)
        await session.commit()
    return await all_values()


def described() -> list[dict[str, str]]:
    """The spec, for a UI that renders itself from it."""
    return [
        {"key": s.key, "type": s.type, "label": s.label,
         "description": s.description, "group": s.group, "status": s.status}
        for s in SPEC
    ]
