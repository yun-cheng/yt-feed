import asyncio
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database import init_db
from app.routers import feed, channels, subscriptions, downloads, hidden
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
    try:
        yield
    finally:
        scheduler.cancel()
        try:
            await scheduler
        except asyncio.CancelledError:
            pass


async def _scheduler_loop():
    await asyncio.sleep(SCAN_STARTUP_DELAY_SECONDS)
    while True:
        _start_refresh_thread()
        await asyncio.sleep(SCAN_INTERVAL_SECONDS)


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