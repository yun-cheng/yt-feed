"""What every yt-dlp call in this app has in common, and how it reports back.

Two jobs, and they are the same job from different ends.

**Cookies and a proxy, in one place.** yt-dlp is reached from nine places here —
the scan, channel lookup, the hover preview, captions, comments, downloads, ASR
audio, imports — and none of them is the right place to decide how to get past
YouTube's bot check. Hosted anywhere but home, a plain request is answered with
"Sign in to confirm you're not a bot" often enough that the app is unusable, and
the answers are a signed-in cookie jar or somebody else's address. Both are one
option each, and both have to be on *every* call or the app half-works in a way
that is very hard to read: titles arrive, captions don't.

**Saying so when it isn't working.** A blocked deployment doesn't look blocked
from inside the app. It looks like channels with no new videos, previews that
never load, a download stuck at "error". So failures are recorded as they happen
and `status_text()` says what has been going on — shown under the cookies field
on the settings page, which is where somebody trying to fix this is looking.

Deliberately NOT a unification of the nine option dicts. Their other settings
differ for reasons each one documents — the scan's retry caps exist because of a
socket leak that once exhausted the machine's ephemeral ports, and the comments
call has its own `extractor_args` that a shared one would clobber. Only the floor
is shared.
"""

from __future__ import annotations

import time
from typing import Any

from app import runtime_config

# What YouTube says when it wants a signed-in session. Matched on so that the one
# failure with a known remedy can be reported as itself rather than as "extraction
# failed", which is what sends people looking in the wrong place.
_BOT_CHECK_MARKERS = (
    "confirm you're not a bot",
    "confirm you are not a bot",
    "sign in to confirm",
    "not a bot",
)

# The last outcome, and a count since the process started. In memory and
# therefore per-process, which is the right lifetime: this answers "is it working
# *now*", and a restart is exactly the event after which the old answer is worth
# discarding.
_last_ok: float | None = None
_last_error: str = ""
_last_error_at: float | None = None
_bot_checks = 0
_errors = 0


class _Recorder:
    """A yt-dlp logger that keeps the last error.

    Installed by `opts()`, so every call site reports failures by virtue of using
    the shared options rather than by remembering to. yt-dlp calls `error` for the
    things that stopped it; `debug`/`info`/`warning` are noise here (the options
    already ask for `quiet`), so they are swallowed as yt-dlp's own logging would
    have been.
    """

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        # Warnings carry the bot check too, on the calls that recover from it.
        if _is_bot_check(msg):
            note_failure(msg)

    def error(self, msg: str) -> None:
        note_failure(msg)


def _is_bot_check(msg: str) -> bool:
    low = msg.lower()
    return any(m in low for m in _BOT_CHECK_MARKERS)


def note_failure(msg: str) -> None:
    global _last_error, _last_error_at, _bot_checks, _errors
    _last_error = msg.strip()[:300]
    _last_error_at = time.time()
    _errors += 1
    if _is_bot_check(msg):
        _bot_checks += 1


def note_success() -> None:
    """Called by the scan, which is the app's heartbeat against YouTube.

    Only from there. Every other call site is something a person triggered, and a
    hover preview that worked says less about the deployment's health than a scan
    that walked every channel.
    """
    global _last_ok
    _last_ok = time.time()


def opts(**extra: Any) -> dict[str, Any]:
    """The shared floor, plus whatever this call site needs.

    `extra` wins, so a site that has a reason to differ keeps it. Cookies and the
    proxy are read per call rather than captured, because both are settings now
    and pasting cookies has to take effect on the next request rather than after
    a restart.
    """
    out: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "logger": _Recorder(),
    }
    cookies = runtime_config.youtube_cookies_file()
    if cookies:
        out["cookiefile"] = cookies
    proxy = runtime_config.youtube_proxy()
    if proxy:
        out["proxy"] = proxy
    out.update(extra)
    return out


def _ago(then: float | None) -> str:
    if then is None:
        return "never"
    secs = int(time.time() - then)
    if secs < 90:
        return "just now"
    if secs < 3600:
        return f"{secs // 60}m ago"
    if secs < 86400:
        return f"{secs // 3600}h ago"
    return f"{secs // 86400}d ago"


def status() -> dict[str, Any]:
    """How extraction has been going, for the settings page's live status line.

    Phrased for the person reading it under the cookies field: whether the last
    scan worked, and if things are failing, whether it is the failure cookies fix.
    """
    using = []
    if runtime_config.youtube_cookies_file():
        using.append("cookies")
    if runtime_config.youtube_proxy():
        using.append("a proxy")
    with_what = f" (using {' and '.join(using)})" if using else ""

    if _bot_checks:
        text = (
            f"YouTube asked us to confirm we're not a bot {_bot_checks} "
            f"time{'s' if _bot_checks > 1 else ''}, last {_ago(_last_error_at)}"
            f"{with_what}. Cookies from a signed-in browser, or a proxy, is what "
            "answers that."
        )
    elif _last_ok is None and _errors:
        text = (
            f"{_errors} extraction failure{'s' if _errors > 1 else ''} and nothing "
            f"through yet{with_what}. Last: {_last_error}"
        )
    elif _last_ok is None:
        text = f"Nothing fetched yet — the first scan runs shortly after startup{with_what}."
    elif _errors:
        text = (
            f"Working — last scan {_ago(_last_ok)}{with_what}. "
            f"{_errors} failure{'s' if _errors > 1 else ''} along the way, "
            f"last {_ago(_last_error_at)}."
        )
    else:
        text = f"Working — last scan {_ago(_last_ok)}{with_what}."

    return {
        "text": text,
        "ok": _errors == 0 or _last_ok is not None,
        "blocked": _bot_checks > 0,
        "failures": _errors,
        "bot_checks": _bot_checks,
    }


def reset() -> None:
    """Forget the recorded history. For tests."""
    global _last_ok, _last_error, _last_error_at, _bot_checks, _errors
    _last_ok = _last_error_at = None
    _last_error = ""
    _bot_checks = _errors = 0
