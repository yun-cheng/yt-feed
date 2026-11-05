"""The Chat tab: a finished stream's chat replay, fetched once and kept.

POST starts the fetch, GET says how it's going and, once it's done, hands over
the whole replay; the page plays it back against the video's clock. The fetch
is a background job rather than a request, because it outlasts one — about 30
seconds for a 3-hour stream — and the person who asked may well have moved on
to another tab, or another video, by the time it lands.

Shared between people: a replay is the same for everyone who watches the
stream, like the video itself.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, HTTPException

from app import auth, live_chat
from app.config import settings
from app.models import User

router = APIRouter(prefix="/chat")

# Two at a time. Each is a long walk of requests to YouTube from this address,
# which is what earns a bot check if too many run at once.
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="live-chat")

# Jobs in flight, and why the last attempt failed. In memory: a restart ends
# every job, and a failure is worth reporting until the next try, not forever.
_jobs: dict[str, asyncio.Task] = {}
_errors: dict[str, str] = {}


def _done_path(video_id: str) -> str:
    return os.path.join(settings.live_chat_dir, f"{video_id}.json")


def _work_dir(video_id: str) -> str:
    return os.path.join(settings.live_chat_dir, f"tmp-{video_id}")


def _check(video_id: str) -> None:
    if not live_chat.VIDEO_ID.match(video_id):
        raise HTTPException(404, "No such video")


def _fetch_and_keep(video_id: str) -> None:
    """Download, trim, and keep. Blocking; runs in `_pool`."""
    work = _work_dir(video_id)
    try:
        raw = live_chat.download(video_id, work)
        with open(raw, "rb") as f:
            messages = live_chat.parse(f)
        done = _done_path(video_id)
        # Written aside and moved into place, so a reader never meets half a file.
        tmp = done + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"messages": messages}, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, done)
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def _run(video_id: str) -> None:
    try:
        await asyncio.get_event_loop().run_in_executor(_pool, _fetch_and_keep, video_id)
        _errors.pop(video_id, None)
    except Exception as e:  # noqa: BLE001 — any failure has to reach the tab
        _errors[video_id] = str(e)[:300] or "The chat replay couldn't be fetched"
    finally:
        _jobs.pop(video_id, None)


def _status(video_id: str) -> dict:
    done = _done_path(video_id)
    if os.path.exists(done):
        with open(done, encoding="utf-8") as f:
            return {"status": "done", **json.load(f)}
    if video_id in _jobs:
        part = os.path.join(_work_dir(video_id), f"{video_id}.{live_chat.LANG}.json.part")
        return {"status": "running", "covered": live_chat.covered_ms(part) / 1000}
    if video_id in _errors:
        return {"status": "error", "error": _errors[video_id]}
    return {"status": "none"}


@router.get("/{video_id}")
async def get_chat(video_id: str, _user: User = Depends(auth.account)):
    """{status: none | running | done | error}. Running carries `covered`, the
    seconds of stream fetched so far; done carries `messages` (see
    live_chat.parse for their shape)."""
    _check(video_id)
    return _status(video_id)


@router.post("/{video_id}")
async def start_chat(video_id: str, _user: User = Depends(auth.account)):
    """Fetch this stream's chat replay, unless it's here or on its way.

    A failed attempt is retried by asking again.
    """
    _check(video_id)
    if not os.path.exists(_done_path(video_id)) and video_id not in _jobs:
        os.makedirs(settings.live_chat_dir, exist_ok=True)
        _errors.pop(video_id, None)
        _jobs[video_id] = asyncio.create_task(_run(video_id))
    return _status(video_id)
