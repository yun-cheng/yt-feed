#!/Users/zeke/personal-youtube-feed/backend/.venv/bin/python
"""Clean up bad channel entries (video IDs that got mixed in)."""
import httpx

# Get all channels
r = httpx.get("http://localhost:8000/api/channels", timeout=10)
channels = r.json()

# Find channels with video-style IDs (not starting with UC)
to_delete = []
for ch in channels:
    yid = ch["youtube_id"]
    # Valid YouTube channel IDs start with "UC"
    if not yid.startswith("UC"):
        to_delete.append(yid)
        print(f"  DELETE {yid} — {ch['title']} (not a valid channel ID)")

print(f"\nDeleting {len(to_delete)} bad entries...")
for yid in to_delete:
    r = httpx.delete(f"http://localhost:8000/api/channels/{yid}", timeout=10)
    print(f"  Deleted {yid}: {r.status_code}")

# Final count
r = httpx.get("http://localhost:8000/api/channels", timeout=10)
final = r.json()
print(f"\nRemaining: {len(final)} channels")
for ch in final:
    print(f"  {ch['youtube_id']} — {ch['title']} (group: {ch.get('group', 'none')})")