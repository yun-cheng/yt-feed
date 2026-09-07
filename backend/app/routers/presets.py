"""Saved filter presets — a sidebar selection, named and put back on later.

Thin on purpose. The server stores the filter blob and never reads inside it:
what a filter MEANS is the sidebar's business, and keeping it that way means a
new filter is a frontend change alone. The one thing enforced here is the shape
(unknown keys are a 400, not a silently stored typo) and the per-user name,
which turns a second save under an existing name into an overwrite.
"""

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth
from app.database import async_session
from app.models import FilterPreset, User

router = APIRouter(prefix="/presets")

MAX_NAME = 60


async def get_db():
    async with async_session() as session:
        yield session


class Filters(BaseModel):
    """The sidebar's filter state, as the chips express it.

    `watch` is nullable for the same reason the URL spells "none": an empty list
    is an explicit "no watch-status filter", while null means "don't touch what
    the page already has" — a preset about tags shouldn't quietly clear it.
    """
    model_config = {"extra": "forbid"}

    tags: list[str] = Field(default_factory=list)
    watch: list[str] | None = None
    summarised: bool = False
    shorts: bool = False
    hidden: bool = False


class PresetPayload(BaseModel):
    name: str
    filters: Filters = Field(default_factory=Filters)


def _clean_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise HTTPException(400, "A preset needs a name")
    return name[:MAX_NAME]


def _serialize(row: FilterPreset) -> dict:
    try:
        filters = json.loads(row.filters or "{}")
    except ValueError:
        # A blob that won't parse is a preset that filters nothing, rather than
        # a list endpoint that 500s because of one bad row.
        filters = {}
    return {
        "id": row.id,
        "name": row.name,
        "filters": Filters(**filters).model_dump() if isinstance(filters, dict) else Filters().model_dump(),
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


async def _by_name(db: AsyncSession, user: User, name: str) -> FilterPreset | None:
    return (await db.execute(
        select(FilterPreset).where(
            FilterPreset.user_id == user.id, FilterPreset.name == name
        )
    )).scalar_one_or_none()


@router.get("")
async def list_presets(
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Oldest first — the order they were made in, which is the order they're
    remembered in. An empty list is the ordinary answer."""
    rows = (await db.execute(
        select(FilterPreset).where(FilterPreset.user_id == user.id).order_by(FilterPreset.id)
    )).scalars().all()
    return [_serialize(r) for r in rows]


@router.post("")
async def save_preset(
    body: PresetPayload,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    """Save the current selection. Re-using a name overwrites that preset, which
    is what "save it again" means when you've adjusted a chip."""
    name = _clean_name(body.name)
    row = await _by_name(db, user, name)
    if row is None:
        row = FilterPreset(user_id=user.id, name=name)
        db.add(row)
    row.filters = json.dumps(body.filters.model_dump())
    await db.commit()
    await db.refresh(row)
    return _serialize(row)


@router.delete("/{preset_id}")
async def delete_preset(
    preset_id: int,
    user: User = Depends(auth.account),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(FilterPreset, preset_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "No such preset")
    await db.delete(row)
    await db.commit()
    return {"ok": True}
