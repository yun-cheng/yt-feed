"""Ask — a conversation about the video you're watching, grounded in its transcript.

The app already holds the thing that makes this answerable: a timed transcript,
parsed and grouped into whole sentences for the caption/translation features.
Handing that to a model with its timestamps still attached is what separates an
answer about THIS video from an answer about the subject in general — and it's
what lets the reply cite `[14:32]`, which the watch page already knows how to
turn into a seek (`linkify`).

Three decisions worth keeping:

- **The whole transcript goes in the prompt.** An hour of speech is ~12k tokens,
  which the flash-tier models this app already pays for take without complaint,
  and a model that has seen the whole video beats any chunk-retrieval scheme at
  the only thing that matters here — knowing what was and wasn't said. Retrieval
  is the fallback for the rare three-hour video, not the design.
- **When it doesn't fit, the window follows the play head.** Same reasoning as
  the translation endpoint: on a video long enough to overflow the budget, the
  question is nearly always about where you are. Which span was actually read is
  reported back, so the panel can say so rather than quietly answering short.
- **The system turn is rebuilt every request**, never stored. The transcript can
  improve underneath a conversation; a stored copy would freeze it.
"""

from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth, llm
from app.database import async_session
from app.models import ChatMessage, Channel, User, Video
from app.routers.feed import _captions_cached, _to_sentences

router = APIRouter(prefix="/ask")


async def get_db():
    async with async_session() as session:
        yield session


# How much transcript may go into one prompt, in CHARACTERS rather than tokens:
# the tokenizer differs per model and a character count is one the code can
# actually check. ~60k chars is roughly 15k tokens of English, or three hours of
# speech — past which the window below starts following the play head.
CONTEXT_CHAR_BUDGET = 60_000

# Turns of history carried into each request (a turn being one exchange). Enough
# for "and what about the second point?" to resolve, short enough that the
# transcript stays the bulk of the prompt.
HISTORY_TURNS = 6

# What a question may cost. Sized for the LONGEST honest answer, not the typical
# one: "summarise this" over a 40-minute tier list is a section per item, and
# measured at ~1,400 tokens. A cap that trims that is worse than a slow answer —
# it cuts the list off partway and the reader can't tell that it did.
MAX_ANSWER_TOKENS = 2500


class AskRequest(BaseModel):
    question: str
    # Where the player is, used only to centre the transcript window on a video
    # too long to send whole. Harmless everywhere else.
    at: float = 0.0


def clock(seconds: float) -> str:
    """Seconds as the timestamp the watch page already linkifies: m:ss / h:mm:ss."""
    s = max(0, int(seconds))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def transcript_window(
    sents: list[dict], at: float, budget: int = CONTEXT_CHAR_BUDGET
) -> tuple[str, float, float, bool]:
    """The transcript as timestamped lines, trimmed to `budget` chars around `at`.

    Returns `(text, covered_start, covered_end, truncated)`. Growth alternates
    forward and back from the sentence being played, so a trimmed window is
    centred on the question rather than starting from a beginning nobody asked
    about. A transcript that fits is returned whole and `truncated` is False.
    """
    if not sents:
        return "", 0.0, 0.0, False

    lines = [f"[{clock(s['start'])}] {s['text']}" for s in sents]
    total = sum(len(x) + 1 for x in lines)
    if total <= budget:
        return "\n".join(lines), sents[0]["start"], sents[-1]["start"], False

    # The sentence being played — the one whose span contains `at`, or the last.
    here = next((i for i, s in enumerate(sents) if at < s.get("end", s["start"])), len(sents) - 1)
    lo = hi = here
    used = len(lines[here]) + 1
    # Alternate outward so the window sits around the play head rather than
    # running to one edge first.
    while True:
        grew = False
        if hi + 1 < len(sents) and used + len(lines[hi + 1]) + 1 <= budget:
            hi += 1
            used += len(lines[hi]) + 1
            grew = True
        if lo - 1 >= 0 and used + len(lines[lo - 1]) + 1 <= budget:
            lo -= 1
            used += len(lines[lo]) + 1
            grew = True
        if not grew:
            break
    return "\n".join(lines[lo:hi + 1]), sents[lo]["start"], sents[hi]["start"], True


def build_system(
    *, title: str, channel: str, topics: list[str], duration: int,
    transcript: str, covered: tuple[float, float], truncated: bool,
) -> str:
    """The system turn: who's speaking, and the rules for answering about them."""
    head = []
    if channel:
        head.append(f"Channel: {channel}")
    if title:
        head.append(f"Title: {title}")
    if duration:
        head.append(f"Length: {clock(duration)}")
    if topics:
        head.append(f"Topics: {', '.join(topics)}")
    if truncated:
        head.append(
            f"NOTE: this video is too long to include whole. The transcript below "
            f"covers {clock(covered[0])}–{clock(covered[1])} only."
        )

    return (
        "You are helping someone understand a video they are watching. Below is "
        "its transcript, one line per sentence, each prefixed with the timestamp "
        "it is spoken at.\n\n"
        + "\n".join(head)
        + "\n\nTranscript:\n"
        + transcript
        + "\n\nRules:\n"
        "- Answer from the transcript. It is the only thing you know about this "
        "video.\n"
        "- If the transcript does not cover what was asked, say so plainly. Do "
        "not fill the gap from general knowledge, and do not guess at what a "
        "video with this title probably said.\n"
        "- Cite timestamps in square brackets, exactly as they appear above — "
        "[12:34] — for anything specific. They become links the reader can click "
        "to jump there.\n"
        "- Reply in the language the question is asked in.\n"
        "- Use Markdown: headings, bullets, **bold** for the things being named. "
        "A structured answer is read at a glance; a paragraph of the same words "
        "is not.\n"
        "- Let the question set the length. Something specific — a fact, a name, "
        "a moment — gets a sentence or two, because this is read beside a playing "
        "video. But a request to summarise, or for the key points, is a request "
        "for COVERAGE: walk the whole video and account for every section and "
        "every item it discusses. If it ranks or lists things, name all of them. "
        "Leaving items out of a summary is the one failure that looks like "
        "success, because what's missing is invisible to whoever is reading."
    )


class NoTranscript(Exception):
    """This video has no captions, so there is nothing to answer from."""


async def build_context(
    db: AsyncSession, video_id: str, at: float = 0.0
) -> tuple[str, float, float, bool]:
    """The system turn for one video, and the transcript span it ended up covering.

    Shared with the background summariser, which needs exactly this prompt and
    none of the conversation around it. Raises `NoTranscript` rather than an
    HTTP error, because one of its two callers is not answering a request.
    """
    captions = await _captions_cached(video_id, "")
    sents = _to_sentences((captions or {}).get("cues") or [])
    if not sents:
        raise NoTranscript(video_id)

    video = await db.get(Video, video_id)
    channel = await db.get(Channel, video.channel_id) if video else None
    try:
        topics = json.loads(video.title_labels) if video and video.title_labels else []
    except ValueError:
        topics = []

    text, lo, hi, truncated = transcript_window(sents, at)
    system = build_system(
        title=video.title if video else "",
        channel=channel.title if channel else "",
        topics=topics if isinstance(topics, list) else [],
        duration=(video.duration_seconds or 0) if video else 0,
        transcript=text, covered=(lo, hi), truncated=truncated,
    )
    return system, lo, hi, truncated


def _serialize(m: ChatMessage) -> dict:
    return {
        "id": m.id,
        "role": m.role,
        "content": m.content or "",
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


async def _thread(db: AsyncSession, user_id: int, video_id: str) -> list[ChatMessage]:
    return list((await db.execute(
        select(ChatMessage)
        .where(ChatMessage.user_id == user_id, ChatMessage.video_id == video_id)
        .order_by(ChatMessage.id)
    )).scalars().all())


@router.get("/{video_id}")
async def get_thread(
    video_id: str,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """The conversation so far, oldest first — what the panel renders on open."""
    return {"messages": [_serialize(m) for m in await _thread(db, user.id, video_id)]}


@router.delete("/{video_id}")
async def clear_thread(
    video_id: str,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Start over. Only ever reaches the asker's own turns."""
    await db.execute(delete(ChatMessage).where(
        ChatMessage.user_id == user.id, ChatMessage.video_id == video_id,
    ))
    await db.commit()
    return {"ok": True}


@router.post("/{video_id}")
async def ask(
    video_id: str,
    p: AskRequest,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Answer a question about the video, streaming the reply as it is written.

    Server-sent events, one JSON object per `data:` line: `{"delta": "..."}` for
    text and a final `{"done": true, ...}` carrying the span actually read and
    the ids of the two rows saved. The panel appends deltas as they land.

    The first token is pulled BEFORE the response starts, so a missing API key or
    a provider error is still an HTTP status the client can act on. After that
    the status is committed and a failure can only end the stream — which is why
    the user's turn is saved at that point and not before: a question with no
    answer in the thread is worse than a question that never landed.
    """
    question = p.question.strip()
    if not question:
        raise HTTPException(400, "Ask something first")

    try:
        system, lo, hi, truncated = await build_context(db, video_id, p.at)
    except NoTranscript:
        # The watch page hides the panel when a video has no captions, the same
        # gate the transcript uses — so this is a direct call, and it deserves
        # the real reason rather than an empty answer.
        raise HTTPException(422, "This video has no transcript to read")

    history = await _thread(db, user.id, video_id)
    turns = [{"role": m.role, "content": m.content} for m in history[-HISTORY_TURNS * 2:]]
    turns.append({"role": "user", "content": question})

    stream = llm.chat_stream(system, turns, max_tokens=MAX_ANSWER_TOKENS)
    try:
        first = await anext(stream)
    except llm.LLMError as e:
        await stream.aclose()
        raise HTTPException(503, str(e))
    except StopAsyncIteration:
        raise HTTPException(503, "empty reply")

    asked = ChatMessage(
        user_id=user.id, video_id=video_id, role="user",
        content=question, created_at=datetime.utcnow(),
    )
    db.add(asked)
    await db.commit()
    asked_id = asked.id

    async def body():
        parts: list[str] = []
        answered = ChatMessage(
            user_id=user.id, video_id=video_id, role="assistant",
            content="", created_at=datetime.utcnow(),
        )
        try:
            parts.append(first)
            yield f"data: {json.dumps({'delta': first})}\n\n"
            async for delta in stream:
                parts.append(delta)
                yield f"data: {json.dumps({'delta': delta})}\n\n"
        except llm.LLMError as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            # Whatever arrived is saved, including a half answer cut off by a
            # closed tab or a dead provider: a visible partial beats a hole in
            # the thread, and the reader can always ask again.
            #
            # Awaiting here is fine while yielding is NOT: a client that
            # disconnects mid-answer has this generator closed underneath it,
            # and a `yield` during that teardown is a RuntimeError that would
            # lose the very partial this block exists to keep. So the closing
            # frame is sent after the block, on the path that still has a reader.
            answered.content = "".join(parts)
            async with async_session() as session:
                session.add(answered)
                await session.commit()

        yield "data: " + json.dumps({
            "done": True, "asked_id": asked_id, "answered_id": answered.id,
            "covered": [lo, hi], "truncated": truncated,
        }) + "\n\n"

    return StreamingResponse(body(), media_type="text/event-stream", headers={
        # Nothing between here and the browser should hold this back waiting for
        # a complete body — the whole point is the first word arriving early.
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })
