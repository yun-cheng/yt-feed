"""App settings — the preferences that live in the app rather than in .env."""

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app import app_settings, auth, runtime_config
from app.config import settings as env_settings
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
    body: SettingsUpdate,
    request: Request,
    user: User | None = Depends(auth.user_or_sole),
):
    """Partial update. An unknown key or a malformed value is a 400, not a
    silent no-op.

    `authorize_write` is what stands between a fresh deployment and whoever
    reaches its URL first. Before accounts exist `user` is None here, and this
    endpoint now writes API keys — so "nobody is signed in" had to stop meaning
    "go ahead". See app/routers/setup.py.
    """
    from app.routers.setup import authorize_write

    await authorize_write(request, user)
    try:
        values = await app_settings.put(body.values, user.id if user else None)
    except (KeyError, ValueError) as e:
        raise HTTPException(400, str(e)) from None
    except PermissionError as e:
        raise HTTPException(401, str(e)) from None
    return {"settings": app_settings.described(), "values": values}


# --- Checking a credential against the thing it's for ------------------------
#
# A key you typed is either right or wrong, and the difference doesn't show until
# something in the app quietly stops working — a channel that never gets tagged,
# a search that always comes back empty. One round trip at the moment of typing
# turns that into an answer.
#
# Only the two that can be checked cheaply and without side effects. The Google
# OAuth client can't: the only way to know it's right is to complete a consent
# flow, which is a browser round trip and is its own answer. Cookies can't
# either — they're checked by extracting a video, which is what the cookies
# field's live status line reports on instead.


async def _test_openrouter() -> tuple[bool, str]:
    key = runtime_config.openrouter_api_key()
    if not key:
        return False, "No key set."
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                f"{env_settings.openrouter_base_url}/key",
                headers={"Authorization": f"Bearer {key}"},
            )
    except httpx.HTTPError as e:
        return False, f"Couldn't reach OpenRouter: {e!r}"
    if r.status_code == 401:
        return False, "OpenRouter rejected the key."
    if r.status_code != 200:
        return False, f"OpenRouter answered {r.status_code}."
    # `/key` describes the key it was called with, which is the one thing worth
    # reporting back: a working key with no credit left fails later, not here.
    data = (r.json() or {}).get("data") or {}
    limit, usage = data.get("limit"), data.get("usage")
    if limit is None:
        return True, "Key works." if usage is None else f"Key works — ${usage:.2f} used."
    return True, f"Key works — ${usage or 0:.2f} of ${limit:.2f} used."


async def _test_meili() -> tuple[bool, str]:
    from app import search_index

    if not await search_index.is_available():
        return False, f"No answer from {env_settings.meili_url}."
    try:
        async with await search_index._client(5.0) as c:
            r = await c.get("/indexes")
    except httpx.HTTPError as e:
        return False, f"Couldn't reach Meilisearch: {e!r}"
    if r.status_code in (401, 403):
        return False, "Meilisearch rejected the key."
    if r.status_code != 200:
        return False, f"Meilisearch answered {r.status_code}."
    return True, "Search is connected."


_TESTS = {"openrouter_api_key": _test_openrouter, "meili_master_key": _test_meili}


@router.post("/test/{key}")
async def test_setting(key: str, user: User | None = Depends(auth.user_or_sole)):
    """Check one credential against the service it's for.

    Behind the same auth as writing it, and it reports only whether the thing
    worked — never the value it used.
    """
    check = _TESTS.get(key)
    if check is None:
        raise HTTPException(404, f"{key} can't be tested")
    ok, text = await check()
    return {"ok": ok, "text": text}
