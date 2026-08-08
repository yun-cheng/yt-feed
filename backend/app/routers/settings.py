"""App settings — the preferences that live in the app rather than in .env."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import app_settings

router = APIRouter(prefix="/settings")


class SettingsUpdate(BaseModel):
    values: dict


@router.get("")
async def read_settings():
    """Every setting, with the spec the page renders itself from.

    Serving the spec rather than a bare value map is what keeps adding a setting
    to one entry in `app_settings.SPEC` — the page grows a control on its own.
    """
    return {"settings": app_settings.described(), "values": await app_settings.all_values()}


@router.put("")
async def write_settings(body: SettingsUpdate):
    """Partial update. An unknown key is a 400, not a silent no-op."""
    try:
        values = await app_settings.put(body.values)
    except KeyError as e:
        raise HTTPException(400, str(e)) from None
    return {"settings": app_settings.described(), "values": values}
