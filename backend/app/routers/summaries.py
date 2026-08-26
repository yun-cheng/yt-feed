"""Long summaries, asked for from a card and written while you do something else.

The Ask panel already answers this question — "summarise this video in full" is
one of its two openers. What it can't do is answer it while you are somewhere
else, and that is the whole point here: a forty-minute video takes the model
twenty to thirty seconds to walk through, which is a long time to sit on a watch
page you only opened to start the job.

So the same prompt runs detached. Three consequences worth naming:

- **The answer lands in the Ask thread**, not in a table of its own. It IS an
  Ask answer; storing it anywhere else would mean the panel showed a summary it
  couldn't discuss and a conversation that didn't know one existed.
- **The job row is the only thing that can report progress.** Nobody is holding
  a stream, so "summarising" has to be state the server wrote down before it
  started, or the card has nothing to label itself with after a refresh.
- **Finishing raises a notification**, because by construction the person who
  asked is not looking at this video.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from functools import partial

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth, llm
from app.database import async_session
from app.models import ChatMessage, Notification, SummaryJob, User, Video
from app.routers.ask import MAX_ANSWER_TOKENS, NoTranscript, build_context

router = APIRouter(prefix="/summaries")


async def get_db():
    async with async_session() as session:
        yield session


# The two questions a job can ask, kept character-identical to the Ask panel's
# two openers (frontend/src/components/AskPanel.tsx) so the two routes to the
# same answer produce the same answer — a summary that differed depending on
# where you started it would be a bug nobody could see.
#
# Both are offered from a card for the same reason the panel offers both: they
# are not a fast one and a good one, they are different amounts of reading. The
# short one is what a card wants ("is this worth 40 minutes?"), and it is also
# the one where the background run matters least — which is precisely why it
# shouldn't be missing from the menu.
SUMMARY_QUESTIONS = {
    "short": "Summarise this video in about three sentences.",
    "long": (
        "Summarise this video in full: walk through it in order and account for "
        "every section and every item it covers, naming each one."
    ),
}
DEFAULT_LENGTH = "long"

# Back-compat alias for the name this module exported when there was one length.
LONG_SUMMARY_QUESTION = SUMMARY_QUESTIONS["long"]


class SummaryRequest(BaseModel):
    # Anything else is refused rather than silently treated as long: a typo
    # here would quietly bill a 2,500-token answer for a three-sentence ask.
    length: str = DEFAULT_LENGTH

# Its own pool, NOT the default executor — the same reason routers/local.py and
# routers/imported.py keep theirs. The channel scanner runs yt-dlp on the default
# one, many at a time and for minutes each, and a summary queued behind that
# waits with no error and no progress. Measured: a job that takes 25 seconds
# alone sat unfinished for 95 during a scan.
#
# Two workers, because the work is a network wait and two people in the house
# asking at once is the realistic ceiling.
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="summary")

# A job still "running" after this long is not running. Nothing survives a
# server restart — uvicorn's --reload alone kills one most days — and an
# orphaned row would otherwise label its card "Summarising" forever. Read-time
# rather than swept: the row is only ever looked at through here.
STALE_AFTER = timedelta(minutes=15)


def _serialize(j: SummaryJob) -> dict:
    status, error = j.status, j.error or ""
    if status == "running" and j.created_at and datetime.utcnow() - j.created_at > STALE_AFTER:
        status, error = "error", "interrupted — the server restarted mid-summary"
    return {
        "video_id": j.video_id,
        "status": status,
        "length": j.length or DEFAULT_LENGTH,
        "error": error,
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "finished_at": j.finished_at.isoformat() if j.finished_at else None,
    }


async def _job(db: AsyncSession, user_id: int, video_id: str) -> SummaryJob | None:
    return (await db.execute(
        select(SummaryJob).where(
            SummaryJob.user_id == user_id, SummaryJob.video_id == video_id,
        )
    )).scalar_one_or_none()


async def _finish(user_id: int, video_id: str, *, error: str) -> None:
    """Close the job out and tell whoever asked — in one transaction, either way.

    Opens its own session: the request that started this returned long ago, and
    with it any session that came from a dependency.
    """
    async with async_session() as db:
        job = await _job(db, user_id, video_id)
        if job:
            job.status = "error" if error else "done"
            job.error = error
            job.finished_at = datetime.utcnow()

        video = await db.get(Video, video_id)
        title = (video.title if video else "") or video_id
        db.add(Notification(
            user_id=user_id,
            kind="summary_error" if error else "summary",
            title="Couldn't summarise" if error else "Summary ready",
            # The title of the video is what identifies it to the reader; the
            # error, when there is one, is what they need instead.
            body=f"{title} — {error}" if error else title,
            video_id=video_id,
            thumbnail_url=(video.thumbnail_url if video else "") or "",
            created_at=datetime.utcnow(),
        ))
        await db.commit()


async def run_summary(user_id: int, video_id: str, length: str = DEFAULT_LENGTH) -> None:
    """Write the summary. Never raises — a background task has nobody to raise to."""
    question = SUMMARY_QUESTIONS[length]
    try:
        async with async_session() as db:
            system, *_ = await build_context(db, video_id)
    except NoTranscript:
        await _finish(user_id, video_id, error="This video has no transcript to read")
        return
    except Exception as e:  # noqa: BLE001 — the job row is the error channel
        await _finish(user_id, video_id, error=str(e) or e.__class__.__name__)
        return

    try:
        # `chat` rather than `chat_stream`: nobody is waiting on the first token,
        # and this is exactly the one-shot call it exists for. It is blocking, so
        # it goes to a thread rather than stalling the event loop for 30 seconds
        # — our own thread, see `_pool`.
        answer = await asyncio.get_running_loop().run_in_executor(
            _pool, partial(
                llm.chat, system, question,
                max_tokens=MAX_ANSWER_TOKENS, temperature=0.3, reasoning=False,
            ),
        )
    except Exception as e:  # noqa: BLE001
        await _finish(user_id, video_id, error=str(e) or e.__class__.__name__)
        return

    answer = (answer or "").strip()
    if not answer:
        await _finish(user_id, video_id, error="empty reply")
        return

    now = datetime.utcnow()
    async with async_session() as db:
        # Both turns, so the thread reads as the conversation it is: opening the
        # panel later shows the question that produced this and can follow it up.
        db.add(ChatMessage(user_id=user_id, video_id=video_id, role="user",
                           content=question, created_at=now))
        db.add(ChatMessage(user_id=user_id, video_id=video_id, role="assistant",
                           content=answer, created_at=now))
        await db.commit()
    await _finish(user_id, video_id, error="")


@router.get("")
async def list_jobs(
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Every job this user has, newest first — what the cards label themselves from."""
    rows = (await db.execute(
        select(SummaryJob)
        .where(SummaryJob.user_id == user.id)
        .order_by(SummaryJob.id.desc())
    )).scalars().all()
    return {"jobs": [_serialize(j) for j in rows]}


@router.get("/{video_id}")
async def get_job(
    video_id: str,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    job = await _job(db, user.id, video_id)
    if not job:
        raise HTTPException(404, "No summary for this video")
    return _serialize(job)


@router.post("/{video_id}")
async def start(
    video_id: str,
    background: BackgroundTasks,
    p: SummaryRequest | None = None,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Start summarising, or say it's already going.

    A second click while one is in flight is a no-op rather than an error: the
    card is already saying "Summarising", and the honest answer to "do it again"
    is that it is being done. Re-running a FINISHED summary is allowed — the
    transcript or the model may be better than it was.
    """
    length = (p.length if p else DEFAULT_LENGTH) or DEFAULT_LENGTH
    if length not in SUMMARY_QUESTIONS:
        raise HTTPException(400, f"No such summary length: {length}")

    job = await _job(db, user.id, video_id)
    # `_serialize` is what decides a stale job is dead, so ask it rather than
    # the column: an orphan from a restart must not block a fresh attempt.
    if job and _serialize(job)["status"] == "running":
        return _serialize(job)

    if job:
        job.status = "running"
        job.length = length
        job.error = ""
        job.created_at = datetime.utcnow()
        job.finished_at = None
    else:
        job = SummaryJob(user_id=user.id, video_id=video_id, status="running",
                         length=length, created_at=datetime.utcnow())
        db.add(job)
    await db.commit()

    # Queued rather than fired: the row is committed first, so the card that
    # polls a moment later cannot miss the job it just asked for.
    background.add_task(run_summary, user.id, video_id, length)
    return _serialize(job)


@router.delete("/{video_id}")
async def forget(
    video_id: str,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Drop the job row, clearing the card's label. The summary itself stays in the thread."""
    await db.execute(delete(SummaryJob).where(
        SummaryJob.user_id == user.id, SummaryJob.video_id == video_id,
    ))
    await db.commit()
    return {"ok": True}
