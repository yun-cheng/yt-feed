import asyncio
import os
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import select
from starlette.middleware.sessions import SessionMiddleware

from app import bootstrap, users
from app.config import settings
from app.database import async_session, init_db
from app.models import User
from app.routers import feed, channels, subscriptions, downloads, hidden, imported, history, local, bookmarks, people, ask, summaries, notifications, presets
from app.routers import search as search_router
from app.routers import settings as settings_router
from app.routers import setup as setup_router
from app.routers import watch_later as watch_later_router
from app.routers import playlists as playlists_router
from app.auth_google import router as auth_router
from app.routers.tags import router as tags_router


# How often the backend scans YouTube for new videos, and how long after startup
# the first scan runs. Scanning is owned by the backend (see _scheduler_loop) so
# freshness no longer depends on a browser tab being open to drive it.
SCAN_INTERVAL_SECONDS = int(os.environ.get("SCAN_INTERVAL_SECONDS", 15 * 60))
SCAN_STARTUP_DELAY_SECONDS = int(os.environ.get("SCAN_STARTUP_DELAY_SECONDS", 30))

# How often the DB is reconciled against your LIVE YouTube subscriptions — a
# different job from the scan above, which only ever re-reads the channels the DB
# already holds. Daily, because it costs an OAuth round-trip and its prune is
# destructive (an unsubscribed channel's videos go with it).
RESYNC_INTERVAL_SECONDS = int(os.environ.get("RESYNC_INTERVAL_SECONDS", 24 * 60 * 60))
RESYNC_STARTUP_DELAY_SECONDS = int(os.environ.get("RESYNC_STARTUP_DELAY_SECONDS", 5 * 60))
# Backoff after a resync that couldn't run (dead token, YouTube hiccup).
RESYNC_RETRY_SECONDS = int(os.environ.get("RESYNC_RETRY_SECONDS", 60 * 60))
# Most channels the unattended job will delete in one go before refusing to.
RESYNC_MAX_PRUNE = int(os.environ.get("RESYNC_MAX_PRUNE", 5))


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(bootstrap.data_dir_note(), flush=True)
    await init_db()
    # After the schema exists, because it asks the database whether anybody owns
    # this deployment yet. Nothing else waits on it.
    await bootstrap.announce_setup()
    # Build the search index in the background — never block or break startup on it.
    async def _init_search():
        from app import search_index
        await search_index.ensure_indexes()
        await search_index.reindex_all()
    asyncio.create_task(_init_search())

    # Backend-owned scan scheduler: one scan shortly after startup, then every
    # SCAN_INTERVAL_SECONDS. The _refreshing guard means overlapping ticks (or a
    # manual /api/refresh) are skipped rather than piling up.
    scheduler = asyncio.create_task(_scheduler_loop())
    resyncer = asyncio.create_task(_resync_loop())
    try:
        yield
    finally:
        for task in (scheduler, resyncer):
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


async def _scheduler_loop():
    await asyncio.sleep(SCAN_STARTUP_DELAY_SECONDS)
    while True:
        _start_refresh_thread()
        await asyncio.sleep(SCAN_INTERVAL_SECONDS)


def _seconds_until_due(last: datetime | None) -> float:
    """How long until a reconcile is due, given when the last one succeeded.

    The clock is persisted (`User.last_resync_at`, previously the mtime of
    subscriptions.yaml) so the schedule survives restarts. A plain sleep loop
    couldn't: it would either re-run the DESTRUCTIVE prune minutes after every
    restart, or push the next resync a full day out on a machine that reboots
    daily.
    """
    if last is None:
        return 0.0  # never reconciled — let _run_resync report why it can't
    elapsed = (datetime.utcnow() - last).total_seconds()
    return max(0.0, RESYNC_INTERVAL_SECONDS - elapsed)


async def _due_users() -> list[int]:
    """Ids of the people whose subscriptions are due a reconcile.

    One clock per person, but for now only ONE person: the live subscription
    list is fetched with the machine's single YouTube token, so a resync run for
    anybody else would reconcile their channels against the token owner's
    subscriptions — pruning everything they hold that the owner doesn't, and
    handing them the owner's list instead. `resync_subscriptions` refuses that
    outright; this doesn't queue it in the first place. The loop is already
    per-user, so wiring per-user tokens through is all that's left.

    Ids rather than rows because each resync opens its own session and a row
    from this one would be detached by the time it got there.
    """
    async with async_session() as session:
        owner = await users.owner_id(session)
        if owner is None:
            return []
        row = (await session.execute(
            select(User.id, User.last_resync_at).where(User.id == owner)
        )).first()
    if row is None or _seconds_until_due(row.last_resync_at) > 0:
        return []
    return [row.id]


async def _resync_loop():
    await asyncio.sleep(RESYNC_STARTUP_DELAY_SECONDS)
    while True:
        due = await _due_users()
        if not due:
            # Nobody is due. Sleeping the full retry interval rather than until
            # the soonest deadline keeps this simple, and the deadline is a day
            # away — an hour of slack on it costs nothing.
            await asyncio.sleep(RESYNC_RETRY_SECONDS)
            continue
        # A successful resync stamps `last_resync_at`, so the check above pushes
        # that person's next one out on its own. The failures that DON'T get
        # that far (no token, auth expired, YouTube down, prune refused) leave
        # the stamp untouched, so back off explicitly instead of retrying in a
        # tight loop. A failure AFTER the stamp — a half-done resync — is left
        # for tomorrow on purpose rather than repeated hourly.
        ok = True
        for user_id in due:
            ok = await _run_resync(user_id) and ok
        if not ok:
            await asyncio.sleep(RESYNC_RETRY_SECONDS)


async def _run_resync(user_id: int) -> bool:
    """Reconcile one person's channels against their live YouTube subscriptions.

    Never raises: this runs unattended, and a dead token or an API hiccup must
    not take the scheduler task down with it.
    """
    global _refreshing
    from app.auth_google import _get_token

    if _get_token() is None:
        print("[resync] skipped — not authenticated (visit /api/auth/login)")
        return False
    if _refreshing:
        # A scan is mid-flight and inserting videos; don't prune underneath it.
        return False

    # Hold the scan guard for the whole reconcile, so a scheduler tick can't
    # start one halfway through the prune. `_refreshing` is only ever cleared by
    # the thread that set it, and we only take it when it's free, so this can't
    # race with a scan's own bookkeeping.
    _refreshing = True
    try:
        from app.routers.subscriptions import resync_subscriptions

        async with async_session() as session:
            user = await session.get(User, user_id)
            if user is None:
                return False
            preview = await resync_subscriptions(dry_run=True, user=user, db=session)
            doomed = preview.get("would_prune_channels", [])
            # An unattended prune this large is far more likely to be a truncated
            # response from YouTube than a real unsubscribe spree — and it would
            # delete a year of videos per channel, irreversibly. Bail loudly and
            # let the manual endpoint (which has ?dry_run=true) settle it.
            if len(doomed) > RESYNC_MAX_PRUNE:
                print(
                    f"[resync] ABORTED — would prune {len(doomed)} channels "
                    f"(limit {RESYNC_MAX_PRUNE}): "
                    f"{', '.join(c['title'] or c['youtube_id'] for c in doomed[:5])}…\n"
                    f"[resync] run POST /api/subscriptions/resync by hand if that's right"
                )
                return False

            result = await resync_subscriptions(dry_run=False, user=user, db=session)
        print(
            f"[resync] user {user_id}: {result.get('live_subscriptions')} live subs — "
            f"+{result.get('added_channels')} added, "
            f"-{result.get('pruned_channels')} pruned "
            f"({result.get('deleted_videos')} videos)"
        )
        return True
    except Exception as e:  # noqa: BLE001 — unattended job; log and retry later
        print(f"[resync] failed: {e}")
        return False
    finally:
        _refreshing = False


app = FastAPI(title="Personal YouTube Feed", lifespan=lifespan)

# The data directory has to be usable before anything serves, and the session
# middleware below needs a key. Here rather than at the top of the module only so
# the imports stay imports; nothing above this line touches the disk.
SECRET_KEY = bootstrap.prepare()

# Whether the session cookie is marked `Secure`. Derived rather than configured,
# because both wrong answers are silent: `Secure` on plain http means the browser
# never stores the cookie and sign-in appears to do nothing, and NOT setting it
# behind https means the cookie is allowed to travel in clear. The scheme of the
# URL people actually use is exactly the thing that decides it.
HTTPS_ONLY = (settings.public_url or settings.app_origin).startswith("https://")

# Narrow on purpose, and in both deployments it barely comes up. In development a
# household reaches the app through the Vite dev server, which listens on every
# interface (`host: true`) and proxies `/api` to this process over loopback — so
# a browser at 192.168.1.50:5173 is making SAME-ORIGIN requests and CORS never
# enters into it. In a container this process serves the built SPA itself (see
# the static mount at the foot of this file), which is same-origin again.
# `public_url` is here for the arrangement in between: a reverse proxy that
# serves the app from one name and forwards /api to this one.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o for o in (
            settings.app_origin, settings.public_url,
            "http://localhost:5173", "http://localhost:3000",
        ) if o
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# The sign-in cookie (see auth.py). `lax` rather than `strict` so arriving back
# from Google's consent screen counts as signed in — a strict cookie is withheld
# on that cross-site redirect, which reads as the login silently failing.
# The extension doesn't use this cookie at all; it carries an API key instead.
app.add_middleware(
    SessionMiddleware,
    secret_key=SECRET_KEY,
    session_cookie="ytfeed_session",
    same_site="lax",
    https_only=HTTPS_ONLY,
    max_age=60 * 60 * 24 * 30,
)

app.include_router(people.router, prefix="/api")
app.include_router(feed.router, prefix="/api")
app.include_router(channels.router, prefix="/api")
app.include_router(downloads.router, prefix="/api")
app.include_router(search_router.router, prefix="/api")
app.include_router(watch_later_router.router, prefix="/api")
app.include_router(playlists_router.router, prefix="/api")
app.include_router(subscriptions.router, prefix="/api")
app.include_router(hidden.router, prefix="/api")
app.include_router(imported.router, prefix="/api")
app.include_router(history.router, prefix="/api")
app.include_router(local.router, prefix="/api")
app.include_router(bookmarks.router, prefix="/api")
app.include_router(ask.router, prefix="/api")
app.include_router(summaries.router, prefix="/api")
app.include_router(notifications.router, prefix="/api")
app.include_router(presets.router, prefix="/api")
app.include_router(settings_router.router, prefix="/api")
app.include_router(setup_router.router, prefix="/api")
app.include_router(auth_router, prefix="/api")
app.include_router(tags_router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/youtube-token")
async def youtube_token_status(force: bool = False):
    """Token health for the stats API — the UI warns you to re-auth when it's dead."""
    from app.youtube_api import youtube_credentials_status
    return youtube_credentials_status(force=force)


@app.get("/api/youtube/extraction-status")
async def extraction_status():
    """Whether yt-dlp is getting through, in a sentence.

    A different question from `/api/youtube-token` above, which is about the OAuth
    token and the Data API. This one is about scraping youtube.com, which is what
    the scan, captions, previews and downloads all go through — and which is what
    a hosted deployment gets refused for. Rendered as the live status line under
    the YouTube cookies setting, hence the `text` key (see `app_settings.Spec`).
    """
    from app import ytdl
    return ytdl.status()


_refreshing = False


def _start_refresh_thread() -> bool:
    """Start a background YouTube scan unless one is already running.

    Returns True if a scan was started, False if one was already in progress.
    Shared by the scheduler loop and the manual /api/refresh endpoint so they
    can never overlap. The blocking yt-dlp work runs in a thread (with its own
    event loop) so it never stalls the loop that serves feed reads.
    """
    global _refreshing
    if _refreshing:
        return False

    _refreshing = True

    def _run():
        import asyncio
        try:
            asyncio.run(_do_refresh())
        finally:
            global _refreshing
            _refreshing = False

    threading.Thread(target=_run, daemon=True).start()
    return True


async def _do_refresh():
    from app.cron_update import run_update
    await run_update()


@app.post("/api/refresh")
async def trigger_refresh():
    """Manually trigger a YouTube channel scan. Normally the backend scheduler
    handles this on its own interval; this endpoint lets you force one."""
    started = _start_refresh_thread()
    return {"status": "started" if started else "already_running"}


@app.get("/api/refresh/status")
async def refresh_status():
    return {"running": _refreshing}


# --- The built frontend ------------------------------------------------------
#
# A container serves the SPA from this process, which makes the app one origin:
# no CORS, no second port to publish, and — the reason it matters most — the
# Google OAuth callback lands on the address people actually typed, so the one
# redirect URI you register in the Cloud console is the one that gets used.
#
# In development none of this is mounted. `frontend/dist` doesn't exist until
# someone runs `npm run build`, and the Vite dev server is the thing serving the
# app and proxying /api here. The existence check is what keeps one file serving
# both arrangements.
SPA_DIR = Path(os.environ.get("SPA_DIR") or Path(settings.project_root) / "frontend" / "dist")


def _spa_file(rel: str) -> Path | None:
    """The built file this request is for, if it is one.

    Resolved and then checked for containment, because `rel` is whatever was in
    the URL: without it, `../../etc/passwd` is a static file request this would
    happily answer.
    """
    if not rel:
        return None
    try:
        candidate = (SPA_DIR / rel).resolve()
    except OSError:
        return None
    root = SPA_DIR.resolve()
    if candidate != root and root not in candidate.parents:
        return None
    return candidate if candidate.is_file() else None


@app.get("/{full_path:path}", include_in_schema=False)
async def spa(full_path: str):
    """A built asset if there is one, `index.html` otherwise.

    The fallback is what makes client-side routes work: the frontend routes on
    `location.pathname` (see the frontend README on History-API routing), so a
    reload on `/watch/abc` arrives here as a request for a file that was never
    built, and has to be answered with the app rather than a 404.

    **A 404 under /api stays a 404.** This route is registered last, so every
    real endpoint above it matches first — but an URL that merely LOOKS like an
    endpoint would otherwise be answered with a page of HTML, and a frontend
    calling a path the backend doesn't serve would read as a JSON parse error
    somewhere far away instead of as the 404 it is. That is exactly what
    `tests/test_api_contract.py` exists to catch, so this must not hide it.

    `include_in_schema=False` for the same reason: this pattern matches
    everything, and in `app.openapi()['paths']` it would make that test's route
    table match every call site no matter how wrong.

    Registered whether or not a build exists, and answering 404 when it doesn't —
    which is what a stray URL gets today. Deciding at request time rather than at
    import keeps development (no `dist`, Vite serving the app) and a container
    (a `dist` baked in) on the same code path.
    """
    if full_path.startswith("api/"):
        raise HTTPException(404, "Not Found")
    index = SPA_DIR / "index.html"
    if not index.is_file():
        raise HTTPException(404, "Not Found")
    return FileResponse(_spa_file(full_path) or index)