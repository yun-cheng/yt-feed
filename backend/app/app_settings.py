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

Each entry declares a `scope`. Most preferences are **yours** and are stored per
person in `user_settings`. A few govern a SHARED resource — the archive fill
spends a daily API quota billed to one Cloud project — and those are `scope="app"`,
stored once in `app_settings`, because a per-person copy would let whoever
flipped it last commit everybody's allowance.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from sqlalchemy import select

from app.config import settings as env_settings
from app.database import async_session
from app.models import AppSetting, UserSetting


@dataclass(frozen=True)
class Spec:
    key: str
    type: str  # "bool" — more as they're needed; the UI switches on this
    default: Callable[[], Any]
    label: str
    description: str
    group: str
    # Who the answer belongs to. "user" is the usual case — a preference is
    # yours. "app" is for a switch that governs a SHARED resource, where a
    # per-person copy would let whoever flipped it last decide for everybody;
    # it's stored once, in `app_settings`, and the page marks it as affecting
    # everyone. See the archive fill below for the case that forced the split.
    scope: str = "user"
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
        # Shared, and not by omission: one unattended sweep spends a daily API
        # quota billed to a single Cloud project, so this is a decision for the
        # machine rather than for each person using it.
        scope="app",
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
    Spec(
        key="youtube_history_sync",
        type="bool",
        # No .env twin: this governs the browser extension, which is optional and
        # has nothing to do with how the server is deployed.
        default=lambda: True,
        scope="user",
        label="Record what you watch on youtube.com",
        description=(
            "With the extension installed, a video you watch on YouTube itself "
            "keeps its place here — the same progress bar, resume point and "
            "History row as one watched in the app. Off, the extension stops "
            "watching within a minute and nothing is recorded in the meantime. "
            "Nothing is ever written the other way; YouTube offers no way in."
        ),
        group="Library",
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


async def _read(session, spec: Spec, user_id: int | None):
    """The stored row for one setting, or None. Which table depends on scope."""
    if spec.scope == "app":
        return (await session.execute(
            select(AppSetting).where(AppSetting.key == spec.key)
        )).scalar_one_or_none()
    if user_id is None:
        return None
    return (await session.execute(
        select(UserSetting).where(
            UserSetting.user_id == user_id, UserSetting.key == spec.key
        )
    )).scalar_one_or_none()


async def get(key: str, user_id: int | None = None) -> Any:
    """One setting's value, falling back to its bootstrap default.

    A user-scoped key read without a `user_id` answers the default rather than
    raising: unattended callers exist (the scanner, the archive sweep), and a
    preference nobody has expressed is exactly what a default is for.
    """
    spec = _BY_KEY[key]
    async with async_session() as session:
        row = await _read(session, spec, user_id)
    return _decode(spec, row.value) if row else spec.default()


async def all_values(user_id: int | None = None) -> dict[str, Any]:
    """Every setting as it applies to this person — their own where the key is
    theirs, the machine's where it isn't."""
    async with async_session() as session:
        app_stored = {
            r.key: r.value for r in
            (await session.execute(select(AppSetting))).scalars().all()
        }
        user_stored = {}
        if user_id is not None:
            user_stored = {
                r.key: r.value for r in
                (await session.execute(
                    select(UserSetting).where(UserSetting.user_id == user_id)
                )).scalars().all()
            }

    out = {}
    for s in SPEC:
        stored = app_stored if s.scope == "app" else user_stored
        out[s.key] = _decode(s, stored[s.key]) if s.key in stored else s.default()
    return out


async def put(updates: dict[str, Any], user_id: int | None = None) -> dict[str, Any]:
    """Store some settings. Unknown keys raise rather than being swallowed."""
    unknown = set(updates) - set(_BY_KEY)
    if unknown:
        raise KeyError(f"unknown setting(s): {', '.join(sorted(unknown))}")

    needs_user = [k for k in updates if _BY_KEY[k].scope == "user"]
    if needs_user and user_id is None:
        raise PermissionError(
            f"sign in to change: {', '.join(sorted(needs_user))}"
        )

    async with async_session() as session:
        for key, value in updates.items():
            spec = _BY_KEY[key]
            row = await _read(session, spec, user_id)
            if row is not None:
                row.value = _encode(spec, value)
            elif spec.scope == "app":
                session.add(AppSetting(key=key, value=_encode(spec, value)))
            else:
                session.add(UserSetting(
                    user_id=user_id, key=key, value=_encode(spec, value)
                ))
        await session.commit()
    return await all_values(user_id)


def described() -> list[dict[str, str]]:
    """The spec, for a UI that renders itself from it."""
    return [
        {"key": s.key, "type": s.type, "label": s.label,
         "description": s.description, "group": s.group, "status": s.status,
         "scope": s.scope}
        for s in SPEC
    ]
