import asyncio
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database import init_db
from app.routers import feed, channels, subscriptions, downloads
from app.routers import search as search_router
from app.routers import watch_later as watch_later_router
from app.routers import playlists as playlists_router
from app.auth_google import router as auth_router
from app.routers.tags import router as tags_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    # Build the search index in the background — never block or break startup on it.
    async def _init_search():
        from app import search_index
        await search_index.ensure_indexes()
        await search_index.reindex_all()
    asyncio.create_task(_init_search())
    yield


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


@app.post("/api/refresh")
async def trigger_refresh():
    """Trigger a YouTube channel scan in the background."""
    global _refreshing
    if _refreshing:
        return {"status": "already_running"}

    _refreshing = True

    def _run():
        import asyncio
        try:
            asyncio.run(_do_refresh())
        finally:
            global _refreshing
            _refreshing = False

    threading.Thread(target=_run, daemon=True).start()
    return {"status": "started"}


async def _do_refresh():
    from app.cron_update import run_update
    await run_update()


@app.get("/api/refresh/status")
async def refresh_status():
    return {"running": _refreshing}