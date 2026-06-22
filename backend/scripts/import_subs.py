#!/Users/zeke/personal-youtube-feed/backend/.venv/bin/python
"""Import subscription data from /tmp/subs.json into the backend."""
import json
import httpx

with open("/tmp/subs.json") as f:
    subs = json.load(f)

channels = [
    {
        "youtube_id": c["youtube_id"],
        "title": c["title"],
        "description": c.get("description", ""),
        "thumbnail_url": c.get("thumbnail_url", ""),
    }
    for c in subs["channels"]
]

print(f"Importing {len(channels)} channels...")
r = httpx.post(
    "http://localhost:8000/api/subscriptions/import",
    json=channels,
    timeout=30,
)
print(f"Status: {r.status_code}")
print(f"Response: {r.json()}")