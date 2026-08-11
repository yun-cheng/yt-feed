"""App settings — the preferences that live in the app rather than in .env."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import app_settings, auth
from app.models import User

router = APIRouter(prefix="/settings")


class SettingsUpdate(BaseModel):
    values: dict


@router.get("")
async def read_settings(user: User | None = Depends(auth.user_or_sole)):
    """Every setting, with the spec the page renders itself from.

    Serving the spec rather than a bare value map is what keeps adding a setting
    to one entry in `app_settings.SPEC` — the page grows a control on its own.
    Each entry carries its `scope`, so the page can say which switches it's
    changing for everyone.
    """
    return {
        "settings": app_settings.described(),
        "values": await app_settings.all_values(user.id if user else None),
    }


@router.put("")
async def write_settings(
    body: SettingsUpdate, user: User | None = Depends(auth.user_or_sole)
):
    """Partial update. An unknown key is a 400, not a silent no-op."""
    try:
        values = await app_settings.put(body.values, user.id if user else None)
    except KeyError as e:
        raise HTTPException(400, str(e)) from None
    except PermissionError as e:
        raise HTTPException(401, str(e)) from None
    return {"settings": app_settings.described(), "values": values}
