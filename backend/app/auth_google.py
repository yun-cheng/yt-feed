"""
Google OAuth — login with Google and fetch YouTube subscriptions.

Uses the existing Google Cloud project (ai-agent-260615) + OAuth credentials.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

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


@router.get("/login")
async def login():
    """Redirect user to Google OAuth consent screen."""
    redirect_uri = "http://localhost:8000/api/auth/callback"
    flow = _make_flow(redirect_uri)
    auth_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    # remember the PKCE verifier for this login so /callback can exchange the code
    if getattr(flow, "code_verifier", None):
        _pending_verifiers[state] = flow.code_verifier
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

    Both halves of what used to be one: the YouTube token still lands in
    `config/youtube_oauth_token.json`, because the scanner and the stats fetcher
    read it from there, and it now also lands on a user row along with a session
    cookie. The file stays the source of truth for the background jobs until
    per-user tokens are wired through — writing both is what lets sign-in ship
    without touching the scan path.
    """
    redirect_uri = "http://localhost:8000/api/auth/callback"
    flow = _make_flow(redirect_uri)
    if state and state in _pending_verifiers:
        flow.code_verifier = _pending_verifiers.pop(state)
    try:
        flow.fetch_token(code=code)
    except Exception as e:
        return _error_page(str(e)[:300])

    creds = flow.credentials
    _save_token(creds)

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

        user = await users.adopt_or_create(
            db,
            google_sub=google_sub,
            email=email,
            name=info.get("name", ""),
            avatar_url=info.get("picture", ""),
        )
        if creds.refresh_token:
            user.refresh_token = creds.refresh_token
            user.token_scopes = " ".join(creds.scopes or [])
        await db.commit()
        auth.sign_in(request, user)

    return RedirectResponse(settings.app_origin)


@router.get("/me")
async def me(user: User | None = Depends(auth.optional_user)):
    """Who's signed in. `{"signed_in": false}` rather than a 401, because the
    app asks this before it knows, and "nobody" is an ordinary answer."""
    if user is None:
        return {"signed_in": False}
    return {
        "signed_in": True,
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "avatar_url": user.avatar_url,
    }


@router.post("/logout")
async def logout(request: Request):
    auth.sign_out(request)
    return {"signed_in": False}


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