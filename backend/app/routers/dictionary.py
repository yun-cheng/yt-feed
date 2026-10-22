"""Hover a word in a paused caption, get its dictionary entry.

The lookup is a blocking C call, so it runs in the thread pool, off the event
loop. See app.dictionary for how it works and why it's handed the whole line.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app import auth, dictionary
from app.models import User

router = APIRouter(prefix="/dictionary")


class Section(BaseModel):
    dictionary: str
    name: str
    definition: str


class Entry(BaseModel):
    term: str
    start: int
    length: int
    sections: list[Section]


@router.get("")
async def look_up(
    # A caption line, which is short; the bound is for anything else.
    text: str = Query(min_length=1, max_length=1000),
    at: int = Query(ge=0),
    _user: User = Depends(auth.account),
) -> Entry | None:
    """The term at UTF-16 unit `at` of `text`, with a section from each
    dictionary that has it; null when none does.

    "Not a word" is null rather than a 404: the page asks on every word the
    pointer crosses, and most of what it crosses (a name, a number) has no
    entry — an ordinary answer, not an error. 503 means no dictionary on this
    server at all, which the page takes as a cue to stop asking.
    """
    if not dictionary.available():
        raise HTTPException(503, "No dictionary on this server")
    e = await run_in_threadpool(dictionary.lookup, text, at)
    return e and Entry(
        term=e.term, start=e.start, length=e.length,
        sections=[Section(dictionary=x.dictionary, name=x.name, definition=x.definition) for x in e.sections],
    )
