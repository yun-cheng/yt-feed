#!/Users/zeke/personal-youtube-feed/backend/.venv/bin/python
"""Fetch subscriptions from J7 brand account and import into the feed."""
import json
import httpx

# Fetch subscriptions
r = httpx.post("http://localhost:8000/api/auth/fetch-subscriptions", timeout=60)
data = r.json()
channels = data["channels"]
print(f"Fetched {len(channels)} channels from YouTube API")

# Import into feed DB
payload = [
    {
        "youtube_id": c["youtube_id"],
        "title": c["title"],
        "description": c.get("description", ""),
        "thumbnail_url": c.get("thumbnail_url", ""),
    }
    for c in channels
]

r2 = httpx.post(
    "http://localhost:8000/api/subscriptions/import",
    json=payload,
    timeout=60,
)
print(f"Import: {r2.json()}")

# Auto-categorize
r3 = httpx.post("http://localhost:8000/api/channels/auto-categorize", timeout=30)
print(f"Categories: {r3.json()}")