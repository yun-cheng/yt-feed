"""Notes on a video — labels, fields and free text, from the panel's Notes tab.

Stored whole, one row per (user, video): the tab sends everything it holds on
each save and gets back what was kept. Whole rather than per-part because the
tab already holds all of it, and a save that restates it can't leave the row
half-written by a request that arrived out of order.

The server tidies what it's given — trims, drops blanks, folds duplicates — so
"Comedy" typed twice is one label however the page sent it, and the
suggestions it hands back are built from clean rows.
"""

import json
from collections import Counter
from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth
from app.database import async_session
from app.models import User, VideoNote

router = APIRouter(prefix="/notes")

# Generous, but a bound: one row is sent whole on every save.
MAX_NOTE = 100_000
MAX_ITEM = 200


async def get_db():
    async with async_session() as session:
        yield session


class Field(BaseModel):
    name: str
    values: list[str] = []


class NotePayload(BaseModel):
    labels: list[str] = []
    fields: list[Field] = []
    note: str = ""


def _distinct(items: list[str]) -> list[str]:
    """Trimmed, blanks dropped, and the first spelling of each kept — "comedy"
    after "Comedy" is the same label, typed again."""
    seen: set[str] = set()
    out = []
    for raw in items:
        item = " ".join(raw.split())[:MAX_ITEM]
        if item and item.casefold() not in seen:
            seen.add(item.casefold())
            out.append(item)
    return out


def _clean(p: NotePayload) -> dict:
    fields: list[dict] = []
    by_name: dict[str, dict] = {}
    for f in p.fields:
        name = " ".join(f.name.split())[:MAX_ITEM]
        if not name:
            continue
        # Two fields of the same name are one field: their values join up.
        if name.casefold() in by_name:
            by_name[name.casefold()]["values"] += f.values
            continue
        entry = {"name": name, "values": list(f.values)}
        by_name[name.casefold()] = entry
        fields.append(entry)
    for f in fields:
        f["values"] = _distinct(f["values"])
    return {
        "labels": _distinct(p.labels),
        "fields": fields,
        # Kept as written, but a note of nothing but whitespace is no note.
        "note": p.note[:MAX_NOTE] if p.note.strip() else "",
    }


def _serialize(row: VideoNote | None) -> dict:
    if row is None:
        return {"labels": [], "fields": [], "note": "", "updated_at": None}
    return {
        "labels": json.loads(row.labels or "[]"),
        "fields": json.loads(row.fields or "[]"),
        "note": row.note or "",
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def _row(db: AsyncSession, user: User, video_id: str) -> VideoNote | None:
    return (await db.execute(
        select(VideoNote).where(VideoNote.user_id == user.id, VideoNote.video_id == video_id)
    )).scalar_one_or_none()


@router.get("/suggestions")
async def suggestions(
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """What you've used before, most used first: labels, field names, and each
    field's values — so the second video's "Actors" offers the first one's.

    A field's values are pooled by its name regardless of case, under the
    spelling used most."""
    rows = (await db.execute(
        select(VideoNote.labels, VideoNote.fields).where(VideoNote.user_id == user.id)
    )).all()
    labels: Counter[str] = Counter()
    label_spelling: dict[str, Counter[str]] = {}
    names: Counter[str] = Counter()
    name_spelling: dict[str, Counter[str]] = {}
    values: dict[str, Counter[str]] = {}
    for labels_json, fields_json in rows:
        for label in json.loads(labels_json or "[]"):
            labels[label.casefold()] += 1
            label_spelling.setdefault(label.casefold(), Counter())[label] += 1
        for f in json.loads(fields_json or "[]"):
            key = f["name"].casefold()
            names[key] += 1
            name_spelling.setdefault(key, Counter())[f["name"]] += 1
            values.setdefault(key, Counter()).update(f.get("values", []))

    def spelt(key: str, spelling: dict[str, Counter[str]]) -> str:
        return spelling[key].most_common(1)[0][0]

    return {
        "labels": [spelt(k, label_spelling) for k, _ in labels.most_common()],
        "fields": {
            spelt(k, name_spelling): [v for v, _ in values.get(k, Counter()).most_common()]
            for k, _ in names.most_common()
        },
    }


@router.get("/video/{video_id}")
async def get_note(
    video_id: str,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """This video's notes. Nothing written is an empty note, not a 404 — the
    tab asks on every video it opens on."""
    return _serialize(await _row(db, user, video_id))


@router.put("/video/{video_id}")
async def put_note(
    video_id: str,
    p: NotePayload,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Replace this video's notes with what was sent, tidied; answers with what
    was kept. Emptied of everything, the row goes, so "has notes" stays a
    question of whether a row exists."""
    clean = _clean(p)
    row = await _row(db, user, video_id)
    if not clean["labels"] and not clean["fields"] and not clean["note"]:
        if row is not None:
            await db.execute(delete(VideoNote).where(VideoNote.id == row.id))
            await db.commit()
        return _serialize(None)
    if row is None:
        row = VideoNote(user_id=user.id, video_id=video_id)
        db.add(row)
    row.labels = json.dumps(clean["labels"], ensure_ascii=False)
    row.fields = json.dumps(clean["fields"], ensure_ascii=False)
    row.note = clean["note"]
    row.updated_at = datetime.utcnow()
    await db.commit()
    return _serialize(row)
