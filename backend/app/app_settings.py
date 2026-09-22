"""
App settings: the switches that belong to *you*, not to the deployment.

`config.py` (`.env`) is for environment wiring — ports, paths, the addresses of
companion services. Those are properties of where the app runs. This module is
for the other kind: preferences about how the app behaves, which should be
changeable from the app itself rather than by editing a file and restarting a
server. A switch that governs an unattended background job especially: turning it
*on* deserves to be deliberate, but turning it *off* has to be immediate, and
"edit .env, restart uvicorn" is the wrong shape for a kill switch.

**API keys live here too** (the `Connections` group, `type="secret"`), which is
the one place that division moved. A key is a property of the deployment rather
than a preference — but requiring a file before the app will start is the step a
person deploying this gets wrong, and it is a bad step to get wrong: the app
comes up, and the half of it that needs the key is quietly missing. Better to
come up and ask. The `.env` variables still work and act as bootstrap defaults;
`app/runtime_config.py` is what decides between the two, and is what the code
using a key actually reads. A secret is never read back out — see `all_values`.

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

import json
from dataclasses import dataclass
from typing import Any, Callable

from sqlalchemy import select

from app.config import settings as env_settings
from app.database import async_session
from app.languages import APP_LANG_OPTIONS, CAPTION_LANG_OPTIONS, TRANSLATE_LANG_OPTIONS
from app.models import AppSetting, UserSetting


# What a playback-speed list may hold. Mirrored in the frontend's
# lib/playbackSpeeds.ts, which is where the same rules are applied as you type.
MIN_SPEED = 0.1
MAX_SPEED = 5
MAX_SPEEDS = 12


@dataclass(frozen=True)
class Spec:
    key: str
    # "bool", "choice" (one of `options`), "secret", or one of the JSON shapes
    # below ("page_defaults", "speeds", "shortcuts"). The UI switches on this to
    # pick the control.
    type: str
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
    # For "choice": the allowed values, each with the label the menu shows, in
    # menu order. Anything else is refused on write.
    options: tuple[tuple[str, str], ...] = ()
    # For "secret": render a textarea rather than a one-line input. A cookie jar
    # is thousands of characters and a key is forty.
    multiline: bool = False
    # For "secret": what an empty field means, shown in the control. Usually where
    # the value comes from instead — an env var, or a default.
    placeholder: str = ""
    # Whether `POST /api/settings/test/{key}` can check this one against the
    # service it configures. See `routers/settings.py`.
    testable: bool = False


SPEC: tuple[Spec, ...] = (
    # --- Connections -------------------------------------------------------
    # The keys and credentials a deployment needs, so that deploying this app is
    # `docker compose up` and then filling in a form — rather than creating a
    # file the app won't start without. All `scope="app"`: they are properties of
    # the deployment, and a per-person copy of an API key would mean whoever
    # saved last decides whose account gets billed.
    #
    # Each has an `.env` twin that acts as a bootstrap default, and a stored
    # value wins over it. See app/runtime_config.py, which is what the code that
    # uses these actually reads.
    Spec(
        key="openrouter_api_key",
        type="secret",
        default=lambda: "",
        scope="app",
        testable=True,
        placeholder="sk-or-v1-…",
        label="OpenRouter API key",
        description=(
            "Turns on the AI features: channel and video tagging, caption "
            "translation, video summaries and Ask. Without it the rest of the app "
            "works and channels are tagged by language alone. "
            "Get one at openrouter.ai."
        ),
        group="Connections",
    ),
    Spec(
        key="google_client_id",
        type="secret",
        default=lambda: "",
        scope="app",
        label="Google OAuth client ID",
        description=(
            "Lets you sign in with Google and import your YouTube subscriptions. "
            "Create an OAuth client (type: Web application) in the Google Cloud "
            "console with the YouTube Data API enabled, and register this app's "
            "address + /api/auth/callback as a redirect URI. Without it, channels "
            "are added by hand."
        ),
        group="Connections",
    ),
    Spec(
        key="google_client_secret",
        type="secret",
        default=lambda: "",
        scope="app",
        label="Google OAuth client secret",
        description="The secret from the same OAuth client as the ID above.",
        group="Connections",
    ),
    Spec(
        key="youtube_cookies",
        type="secret",
        multiline=True,
        default=lambda: "",
        scope="app",
        # Reuses the generic live-status line the settings page already renders,
        # so the one thing you want to know after pasting these — is extraction
        # working now? — is answered in place.
        status="/api/youtube/extraction-status",
        placeholder="# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\t…",
        label="YouTube cookies",
        description=(
            "For a server YouTube won't serve. Hosted away from home, requests "
            "often come back asking you to confirm you're not a bot, and cookies "
            "from a signed-in browser are what answers that. Export them with a "
            "cookies.txt extension and paste the file here. "
            "⚠ These are a full session for that Google account — far more than "
            "signing in grants — and replaying them from a datacenter address is "
            "a known way to get an account flagged. Use a throwaway account, "
            "never your main one."
        ),
        group="Connections",
    ),
    Spec(
        key="youtube_proxy",
        # A secret rather than plain text, because a residential proxy URL
        # routinely carries its credentials in it (http://user:pass@host:port) —
        # so this field is a password that happens to look like an address.
        type="secret",
        default=lambda: "",
        scope="app",
        placeholder="http://user:pass@host:port",
        label="YouTube proxy",
        description=(
            "The other answer to the same problem: send yt-dlp's requests from "
            "somewhere else. A residential proxy is what usually works where a "
            "datacenter address doesn't. Applies to metadata, captions and "
            "downloads alike."
        ),
        group="Connections",
    ),
    Spec(
        key="meili_master_key",
        type="secret",
        default=lambda: "",
        scope="app",
        testable=True,
        placeholder="not needed for the bundled Meilisearch",
        label="Meilisearch key",
        description=(
            "Only for pointing MEILI_URL at a Meilisearch that requires a key. "
            "The one in the bundled compose file needs none — it isn't reachable "
            "from outside. Search is optional throughout: without it, search "
            "returns nothing and everything else is unaffected."
        ),
        group="Connections",
    ),
    Spec(
        key="app_language",
        type="choice",
        options=tuple(APP_LANG_OPTIONS),
        default=lambda: "auto",
        scope="user",
        label="App language",
        description=(
            "The language of menus, buttons and messages. Following the browser "
            "picks the first of these your browser prefers, or English."
        ),
        group="Language",
    ),
    Spec(
        key="caption_lang",
        type="choice",
        # "" is no particular language: the video's own track, as before.
        options=(("", "The video's own language"), *CAPTION_LANG_OPTIONS),
        default=lambda: "",
        scope="user",
        label="Captions open in",
        description=(
            "The caption language every video starts with, when the video offers "
            "it. Switching language on a video lasts for that video."
        ),
        group="Language",
    ),
    Spec(
        key="caption_lang2",
        type="choice",
        options=(("", "None"), *CAPTION_LANG_OPTIONS),
        default=lambda: "",
        scope="user",
        label="Second caption track",
        description=(
            "A second language shown under the first, for following along in "
            "two at once."
        ),
        group="Language",
    ),
    Spec(
        key="translate_lang",
        type="choice",
        options=tuple(TRANSLATE_LANG_OPTIONS),
        default=lambda: "",
        scope="user",
        label="Translate comments into",
        description=(
            "The language a comment's Translate button translates into. A comment "
            "already in it offers no button."
        ),
        group="Language",
    ),
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
    Spec(
        key="playback_speeds",
        # A JSON list of numbers: the rates the player's speed menu offers, and
        # the ones the slower/faster keys step through. One list for both — a
        # menu that can't reach the speed the keyboard just set would be lying
        # about where you are.
        type="speeds",
        default=lambda: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
        scope="user",
        label="Playback speeds",
        description=(
            "The speeds the player's speed menu offers, and the steps the "
            "slower/faster keys take. Normal speed is always included."
        ),
        group="Player",
    ),
    Spec(
        key="shortcuts",
        # A JSON object of action -> key, holding only what you REBOUND. The
        # frontend owns the vocabulary (which actions exist, what each ships on
        # — see lib/shortcuts.ts), so this side checks the shape and stores it,
        # exactly as page_defaults does. Keeping only the changes means a
        # default that moves later moves for everyone who never touched it.
        type="shortcuts",
        default=lambda: {},
        scope="user",
        label="Keyboard shortcuts",
        description=(
            "The keys the player answers to. Click a key to put that action "
            "somewhere else, or ✕ to leave it with no key at all; space and "
            "Esc are fixed."
        ),
        group="Player",
    ),
    Spec(
        key="page_defaults",
        # A JSON object of page -> {age, sort, watch}, holding only what you
        # changed; anything absent follows the built-in table in the frontend's
        # lib/pageDefaults.ts. The frontend owns the vocabulary (which pages,
        # which sorts), so this side only checks the shape and stores it.
        type="page_defaults",
        default=lambda: {},
        scope="user",
        label="What each page opens on",
        description=(
            "The time window, sort and watch filter a page starts with. "
            "Changing them on the page itself still lasts only for that visit."
        ),
        group="Pages",
    ),
)

# Types stored as JSON text rather than as a flag.
_JSON_TYPES = {"page_defaults", "speeds", "shortcuts"}

# Types whose value is a string the user typed. One member today, and named for
# the shape rather than for that one member: what these share is the validation
# (a length cap, and single-line unless `multiline`) and the write semantics (an
# emptied field removes the row). A non-secret free-text setting would join it and
# would differ only in being readable back — see `all_values`.
_STRING_TYPES = {"secret"}

# Longest value accepted, by shape. The multiline limit is sized for a
# cookies.txt (tens of KB in practice); the other is sized for an API key, and
# stops a paste into the wrong field becoming a row nothing will ever read.
_MAX_LEN = 500
_MAX_LEN_MULTILINE = 200_000

_BY_KEY = {s.key: s for s in SPEC}


def _decode(spec: Spec, raw: str) -> Any:
    if spec.type == "bool":
        return raw == "1"
    if spec.type in _JSON_TYPES:
        # A row that no longer parses reads as the default rather than
        # breaking the settings page it would be shown on.
        try:
            return json.loads(raw)
        except ValueError:
            return spec.default()
    if spec.type == "choice" and raw not in {v for v, _ in spec.options}:
        # An option since retired reads as the default.
        return spec.default()
    return raw


def _encode(spec: Spec, value: Any) -> str:
    if spec.type == "bool":
        return "1" if value else "0"
    if spec.type in _JSON_TYPES:
        return json.dumps(value, separators=(",", ":"))
    if spec.type in _STRING_TYPES:
        # Stripped, because a key pasted out of a web page arrives with a newline
        # on it more often than not, and a newline inside an Authorization header
        # is a request httpx refuses to send at all — a failure that looks like a
        # rejected key rather than like whitespace.
        return str(value).strip()
    return str(value)


def _check(spec: Spec, value: Any) -> None:
    """Refuse a value of the wrong shape before it's stored."""
    if spec.type in _STRING_TYPES:
        if not isinstance(value, str):
            raise ValueError(f"{spec.key} must be a string")
        cap = _MAX_LEN_MULTILINE if spec.multiline else _MAX_LEN
        if len(value) > cap:
            raise ValueError(f"{spec.key} must be at most {cap} characters")
        # Checked on the STRIPPED value, because the two cases look alike and
        # deserve opposite answers: a key copied out of a web page arrives with a
        # trailing newline almost every time and is perfectly good, while a break
        # in the MIDDLE of a one-line credential is a paste that went wrong and
        # would authenticate as nothing. So strip the first, refuse the second.
        inner = value.strip()
        if not spec.multiline and ("\n" in inner or "\r" in inner):
            raise ValueError(f"{spec.key} must be a single line")
    if spec.type == "choice":
        if value not in {v for v, _ in spec.options}:
            raise ValueError(f"{spec.key} must be one of its options")
    if spec.type == "page_defaults":
        if not isinstance(value, dict) or not all(
            isinstance(v, dict) for v in value.values()
        ):
            raise ValueError(f"{spec.key} must be an object of objects")
    if spec.type == "speeds":
        # Bounds rather than a fixed list: what counts as a useful speed is the
        # point of the setting. The floor is a speed you can still follow, the
        # ceiling is where the audio stops being speech, and the count is a menu
        # that still fits over a video. 1 has to be in it — it's where every
        # video starts and the one rate you must be able to get back to.
        if (not isinstance(value, list) or not 1 <= len(value) <= MAX_SPEEDS
                or any(isinstance(v, bool) or not isinstance(v, (int, float))
                       or not MIN_SPEED <= v <= MAX_SPEED for v in value)):
            raise ValueError(
                f"{spec.key} must be up to {MAX_SPEEDS} numbers "
                f"between {MIN_SPEED} and {MAX_SPEED}"
            )
        if 1 not in value:
            raise ValueError(f"{spec.key} must include normal speed (1)")
    if spec.type == "shortcuts":
        # Which actions exist is the frontend's vocabulary, so an id it doesn't
        # know is its problem to ignore (it does); what's checked here is that
        # this is a map of names to single keys, and that no two actions were
        # sent on the same one.
        if not isinstance(value, dict) or not all(
            isinstance(k, str) and isinstance(v, str) and len(v) <= 20
            for k, v in value.items()
        ):
            raise ValueError(f"{spec.key} must be an object of action -> key")
        # "" is an action with NO key — a shortcut taken away rather than moved
        # — so any number of actions may hold it. Every real key is one action's.
        bound = [v for v in value.values() if v]
        if len(set(bound)) != len(bound):
            raise ValueError(f"{spec.key} has two actions on one key")


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
        if s.type == "secret":
            out[s.key] = _secret_view(s.key, stored_here=bool(app_stored.get(s.key)))
            continue
        stored = app_stored if s.scope == "app" else user_stored
        out[s.key] = _decode(s, stored[s.key]) if s.key in stored else s.default()
    return out


def _secret_view(key: str, *, stored_here: bool) -> dict[str, Any]:
    """What a secret looks like from outside: whether it is set, and a hint.

    **Never the value.** A settings page needs to show that a key is in place and
    which one it is; it never needs to show the key. An endpoint that returned it
    would put every stored credential one stray `GET` away — read by anything
    holding a session, logged by a proxy, pasted into an issue along with the
    rest of a settings dump.

    `from_env` is the other half of being honest. These values fall back to the
    environment (see runtime_config), so a key set in `.env` must not read as
    "not set": the page would offer to fill in a field that is already answered,
    and clearing it would appear to do nothing.
    """
    from app import runtime_config

    return {
        "set": runtime_config.is_set(key),
        "hint": runtime_config.hint(key),
        "from_env": runtime_config.is_set(key) and not stored_here,
    }


async def put(updates: dict[str, Any], user_id: int | None = None) -> dict[str, Any]:
    """Store some settings. Unknown keys raise KeyError and a value of the
    wrong shape ValueError, rather than either being swallowed."""
    unknown = set(updates) - set(_BY_KEY)
    if unknown:
        raise KeyError(f"unknown setting(s): {', '.join(sorted(unknown))}")

    for key, value in updates.items():
        _check(_BY_KEY[key], value)

    needs_user = [k for k in updates if _BY_KEY[k].scope == "user"]
    if needs_user and user_id is None:
        raise PermissionError(
            f"sign in to change: {', '.join(sorted(needs_user))}"
        )

    async with async_session() as session:
        for key, value in updates.items():
            spec = _BY_KEY[key]
            row = await _read(session, spec, user_id)
            encoded = _encode(spec, value)
            if spec.type in _STRING_TYPES and not encoded:
                # An emptied field is a value REMOVED, not a value of "". The
                # difference shows twice: a row holding "" would report itself as
                # "set here" on the settings page, and it would shadow the
                # environment variable this key falls back to — so clearing a key
                # in the UI would disable a feature `.env` still configures.
                if row is not None:
                    await session.delete(row)
                continue
            if row is not None:
                row.value = encoded
            elif spec.scope == "app":
                session.add(AppSetting(key=key, value=encoded))
            else:
                session.add(UserSetting(user_id=user_id, key=key, value=encoded))
        await session.commit()

    _after_write(updates)
    return await all_values(user_id)


def _after_write(updates: dict[str, Any]) -> None:
    """Make the change visible to the code that reads these values.

    `runtime_config` caches, because its callers are sync and can't await a
    query — so a write has to say so. And the cookie jar has to reach the disk,
    because yt-dlp is given a path rather than a string.
    """
    from app import runtime_config

    runtime_config.invalidate()
    if "youtube_cookies" in updates:
        runtime_config.write_cookies_file(str(updates["youtube_cookies"]))


def described() -> list[dict[str, Any]]:
    """The spec, for a UI that renders itself from it."""
    return [
        {"key": s.key, "type": s.type, "label": s.label,
         "description": s.description, "group": s.group, "status": s.status,
         "scope": s.scope,
         **({"options": [{"value": v, "label": l} for v, l in s.options]}
            if s.type == "choice" else {}),
         **({"multiline": s.multiline, "placeholder": s.placeholder,
             "testable": s.testable}
            if s.type in _STRING_TYPES else {})}
        for s in SPEC
    ]
