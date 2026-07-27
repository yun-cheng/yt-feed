import asyncio
import os
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import async_session, init_db
from app.routers import feed, channels, subscriptions, downloads, hidden, imported, history
from app.routers import search as search_router
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
    await init_db()
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


def _seconds_until_resync_due() -> float:
    """How long until the subscription list is due for a reconcile.

    The clock is the mtime of subscriptions.yaml, which a successful resync
    rewrites — so the schedule survives restarts. A plain sleep loop couldn't:
    it would either re-run the DESTRUCTIVE prune minutes after every restart, or
    push the next resync a full day out on a machine that reboots daily.
    """
    try:
        last = os.path.getmtime(settings.subscriptions_path)
    except OSError:
        return 0.0  # never imported — let _run_resync report why it can't run
    return max(0.0, last + RESYNC_INTERVAL_SECONDS - time.time())


async def _resync_loop():
    await asyncio.sleep(RESYNC_STARTUP_DELAY_SECONDS)
    while True:
        wait = _seconds_until_resync_due()
        if wait > 0:
            await asyncio.sleep(wait)
            continue
        # A successful resync rewrites subscriptions.yaml, so the mtime check
        # above pushes the next one out on its own. The failures that DON'T get
        # that far (no token, auth expired, YouTube down, prune refused) leave
        # the file untouched, so back off explicitly instead of retrying in a
        # tight loop. A failure AFTER the write — a half-done resync — is left
        # for tomorrow on purpose rather than repeated hourly.
        if not await _run_resync():
            await asyncio.sleep(RESYNC_RETRY_SECONDS)


async def _run_resync() -> bool:
    """Reconcile the DB against live YouTube subscriptions. Returns success.

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
            preview = await resync_subscriptions(dry_run=True, db=session)
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

            result = await resync_subscriptions(dry_run=False, db=session)
        print(
            f"[resync] {result.get('live_subscriptions')} live subs — "
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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