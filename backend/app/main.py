import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database import init_db
from app.routers import feed, channels, subscriptions
from app.auth_google import router as auth_router
from app.routers.tags import router as tags_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
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
app.include_router(subscriptions.router, prefix="/api")
app.include_router(auth_router, prefix="/api")
app.include_router(tags_router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok"}