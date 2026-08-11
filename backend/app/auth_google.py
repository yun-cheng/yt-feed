"""
Google OAuth — login with Google and fetch YouTube subscriptions.

Uses the existing Google Cloud project (ai-agent-260615) + OAuth credentials.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

from app import auth, users
from app.config import settings
from app.database import async_session
from app.models import User

router = APIRouter(prefix="/auth")

# --- OAuth 2.0 scopes ---
# `youtube.readonly` is what the app came for. The other three are what turned
# this from "hold a token" into "know who you are": they add an id_token and the
# userinfo endpoint, whose `sub` claim is the stable per-account identifier every
# personal row is keyed by.
SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/youtube.readonly",
]

# Google hands back the union of everything you've ever granted (that's what
# `include_granted_scopes` asks for), and oauthlib treats "got more than I asked
# for" as a mismatch worth raising on. Relax it, or every sign-in after a scope
# change fails on a warning about having been given too much.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

# Where to send the browser after a successful sign-in, stashed for the round
# trip through Google.
_RETURN_KEY = "post_login"

CLIENT_SECRET_PATH = os.path.expanduser("~/.hermes/google_client_secret.json")
TOKEN_PATH = str(Path(settings.config_dir) / "youtube_oauth_token.json")


def _make_flow(redirect_uri: str | None = None) -> Flow:
    flow = Flow.from_client_secrets_file(CLIENT_SECRET_PATH, scopes=SCOPES)
    if redirect_uri:
        flow.redirect_uri = redirect_uri
    return flow


# PKCE: the code_verifier generated in /login must be reused in /callback to
# exchange the code. Stashed here by `state` (short-lived, popped on callback).
_pending_verifiers: dict[str, str] = {}


def _get_token() -> Credentials | None:
    """Load the saved OAuth token written by the in-app login flow."""
    try:
        with open(TOKEN_PATH) as f:
            return Credentials.from_authorized_user_info(json.load(f), SCOPES)
    except (FileNotFoundError, ValueError):
        return None


def _save_token(creds: Credentials):
    """Persist OAuth token."""
    Path(TOKEN_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(TOKEN_PATH, "w") as f:
        json.dump({
            "token": creds.token,
            "refresh_token": creds.refresh_token,
            "token_uri": creds.token_uri,
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "scopes": creds.scopes,
        }, f)


def _redirect_uri(request: Request) -> str:
    """Where Google should send the browser back to, derived from where the
    request came from rather than hardcoded.

    A household reaches this server at whatever address its router handed out,
    and a callback pinned to `localhost` sends the person's browser to their OWN
    machine, where nothing is listening.

    Deriving it is necessary but not sufficient: **every** value this can produce
    has to be registered on the OAuth client in the Google Cloud console, and
    Google only accepts `http` for `localhost` / `127.0.0.1`. A private LAN
    address over plain http is rejected there, so the deriving matters when the
    app is reached over https by a real hostname — see the backend README.
    """
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/auth/callback"


def _return_to(request: Request) -> str:
    """Where to land after signing in — the app the login was started from.

    Taken from the `Referer` the app's own link carries, so someone signing in
    at 192.168.1.50 isn't returned to the owner's `localhost`. Anything that
    isn't a plain origin falls back to the configured one rather than being
    trusted: this value becomes a redirect, and an open one is worth avoiding
    even on a home network.
    """
    referer = request.headers.get("referer", "")
    try:
        parsed = urlparse(referer)
    except ValueError:
        return settings.app_origin
    if parsed.scheme in ("http", "https") and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    return settings.app_origin


@router.get("/login")
async def login(request: Request):
    """Redirect user to Google OAuth consent screen."""
    redirect_uri = _redirect_uri(request)
    flow = _make_flow(redirect_uri)
    auth_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    # remember the PKCE verifier for this login so /callback can exchange the code
    if getattr(flow, "code_verifier", None):
        _pending_verifiers[state] = flow.code_verifier
    # Remembered rather than passed through Google, which would put it in a URL
    # and in the console's registered-URI list.
    request.session[_RETURN_KEY] = _return_to(request)
    return RedirectResponse(auth_url)


def _error_page(message: str) -> HTMLResponse:
    return HTMLResponse(f"""
    <html><body style="background:#0f0f0f;color:white;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
    <div style="text-align:center;max-width:520px">
      <h1>⚠️ Sign-in failed</h1>
      <p style="color:#f87171">{message}</p>
      <p style="color:#aaa">Close this tab and click “Re-authenticate” in the app to try again.</p>
    </div>
    </body></html>
    """, status_code=400)


async def _fetch_userinfo(access_token: str) -> dict:
    """Who this token belongs to, from Google's own mouth.

    Preferred over decoding the id_token ourselves: same authority, one less
    piece of signature-and-clock-skew handling to get wrong, and the token was
    minted seconds ago over TLS from the endpoint we're now asking.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"}
        )
    if resp.status_code != 200:
        raise RuntimeError(f"userinfo {resp.status_code}: {resp.text[:200]}")
    return resp.json()


@router.get("/callback")
async def callback(code: str, request: Request, state: str | None = None):
    """Exchange the code for a token, and sign the person in.

    Both halves of what used to be one: the YouTube token lands on the user row,
    and — for the owner only — in `config/youtube_oauth_token.json`, because the
    scanner and the stats fetcher read it from there. That file is machine-wide,
    so it is written only when the person signing in is the account that owns it
    (`users.owner_id`). Otherwise a family member signing in with Google would
    silently repoint the background scan, the archive fill and everyone's resync
    at their YouTube account and quota.
    """
    redirect_uri = _redirect_uri(request)
    flow = _make_flow(redirect_uri)
    if state and state in _pending_verifiers:
        flow.code_verifier = _pending_verifiers.pop(state)
    try:
        flow.fetch_token(code=code)
    except Exception as e:
        return _error_page(str(e)[:300])

    creds = flow.credentials

    try:
        info = await _fetch_userinfo(creds.token)
    except Exception as e:
        return _error_page(f"Signed in with Google, but couldn't read the account: {e}")

    google_sub = info.get("sub", "")
    email = info.get("email", "")
    if not google_sub:
        return _error_page("Google didn't say which account that was.")

    async with async_session() as db:
        if not await auth.may_sign_in(db, google_sub, email):
            return _error_page(
                f"{email or 'That account'} isn't allowed to use this app. "
                "Add it to ALLOWED_EMAILS in the backend's .env and try again."
            )

        # Who the browser already said it was. A session naming a row that has
        # no Google identity yet is that row claiming this one — see
        # `adopt_or_create`, which without it would strand the owner's data the
        # moment a second account existed.
        session_id = (request.scope.get("session") or {}).get(auth.SESSION_USER_KEY)
        current = await db.get(User, session_id) if session_id else None

        owner = await users.owner_id(db)
        user = await users.adopt_or_create(
            db,
            google_sub=google_sub,
            email=email,
            name=info.get("name", ""),
            avatar_url=info.get("picture", ""),
            current=current,
        )
        if creds.refresh_token:
            user.refresh_token = creds.refresh_token
            user.token_scopes = " ".join(creds.scopes or [])
        await db.commit()
        # The shared file is the owner's, or nobody's yet — see the docstring.
        if owner is None or user.id == owner:
            _save_token(creds)
        auth.sign_in(request, user)

    return RedirectResponse(request.session.pop(_RETURN_KEY, settings.app_origin))


@router.get("/me")
async def me(
    session_user: User | None = Depends(auth.optional_user),
    effective: User | None = Depends(auth.user_or_sole),
):
    """Who the app will answer as. Never a 401 — the page asks before it knows,
    and "nobody" is an ordinary answer.

    Two flags, because they answer different questions. `signed_in` means a
    session cookie or API key named this person. `resolved` means the app will
    serve their data, which is also true when nobody is signed in and the
    machine has exactly one account (`auth.user_or_sole`).

    The frontend gates on `resolved`: it decides whether to show the app or the
    way in. `signed_in` is what a "Sign out" button should follow.
    """
    if effective is None:
        return {"signed_in": False, "resolved": False}
    return {
        "signed_in": session_user is not None,
        "resolved": True,
        "id": effective.id,
        "email": effective.email,
        "name": effective.name,
        "avatar_url": effective.avatar_url,
    }


@router.post("/logout")
async def logout(request: Request):
    auth.sign_out(request)
    return {"signed_in": False}


@router.get("/api-key")
async def api_key(user: User = Depends(auth.account)):
    """The bearer token for the browser extension, to paste into its options.

    Behind the same auth as everything else, and it returns the CALLER's key —
    there's no route to anyone else's. Handing it over on request is the point:
    the extension can't read a session cookie from a youtube.com page context,
    so a key that has to be carried by hand is what replaces one.
    """
    return {"api_key": user.api_key, "app_origin": settings.app_origin}


@router.get("/status")
async def auth_status():
    """Check if user is authenticated."""
    creds = _get_token()
    if not creds:
        return {"authenticated": False}
    try:
        if creds.expired and creds.refresh_token:
            creds.refresh(GoogleRequest())
            _save_token(creds)
        return {
            "authenticated": True,
            "expires_at": creds.expiry.isoformat() if creds.expiry else None,
        }
    except Exception:
        return {"authenticated": False}


@router.post("/fetch-subscriptions")
async def fetch_subscriptions():
    """
    Fetch all YouTube channels the user is subscribed to.
    Uses the saved OAuth token. Returns channel list.
    """
    creds = _get_token()
    if not creds:
        raise HTTPException(401, "Not authenticated. Visit /api/auth/login first.")

    # Refresh if expired
    if creds.expired and creds.refresh_token:
        creds.refresh(GoogleRequest())
        _save_token(creds)

    # Call YouTube Data API: subscriptions.list
    headers = {"Authorization": f"Bearer {creds.token}"}
    channels = []
    page_token = None

    async with httpx.AsyncClient() as client:
        while True:
            params = {
                "part": "snippet",
                "mine": "true",
                "maxResults": 50,
            }
            if page_token:
                params["pageToken"] = page_token

            resp = await client.get(
                "https://www.googleapis.com/youtube/v3/subscriptions",
                headers=headers,
                params=params,
            )
            if resp.status_code != 200:
                raise HTTPException(resp.status_code, f"YouTube API error: {resp.text}")

            data = resp.json()
            for item in data.get("items", []):
                snippet = item.get("snippet", {})
                resource = snippet.get("resourceId", {})
                channels.append({
                    "youtube_id": resource.get("channelId", ""),
                    "title": snippet.get("title", ""),
                    "description": snippet.get("description", ""),
                    "thumbnail_url": snippet.get("thumbnails", {}).get("default", {}).get("url", ""),
                })

            page_token = data.get("nextPageToken")
            if not page_token:
                break

    return {"channels": channels, "count": len(channels)}