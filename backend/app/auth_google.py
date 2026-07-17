"""
Google OAuth — login with Google and fetch YouTube subscriptions.

Uses the existing Google Cloud project (ai-agent-260615) + OAuth credentials.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

from app.config import settings

router = APIRouter(prefix="/auth")

# --- OAuth 2.0 scopes ---
SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
]

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


@router.get("/callback")
async def callback(code: str, request: Request, state: str | None = None):
    """Handle OAuth callback — exchange code for token."""
    redirect_uri = "http://localhost:8000/api/auth/callback"
    flow = _make_flow(redirect_uri)
    if state and state in _pending_verifiers:
        flow.code_verifier = _pending_verifiers.pop(state)
    try:
        flow.fetch_token(code=code)
    except Exception as e:
        return _error_page(str(e)[:300])
    _save_token(flow.credentials)

    return HTMLResponse("""
    <html><body style="background:#0f0f0f;color:white;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
    <div style="text-align:center">
      <h1>✅ Logged in</h1>
      <p>You can close this tab and go back to the app.</p>
    </div>
    </body></html>
    """)


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