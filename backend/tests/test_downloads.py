"""Downloads — the receipt a deletion hands back.

The fetching itself is yt-dlp's and isn't exercised here; what matters for undo
is that deleting a download answers with enough to ask for it again.
"""

import pytest

from app.models import Download


@pytest.mark.asyncio
async def test_deleting_hands_back_what_it_would_take_to_fetch_again(client, db):
    db.add(Download(
        youtube_id="vid1", title="A Video", channel_id="c1", channel_name="A Channel",
        thumbnail_url="https://example.test/a.jpg", duration_seconds=600,
        status="ready", filesize=1234,
    ))
    await db.commit()

    removed = (await client.delete("/api/downloads/vid1")).json()["removed"]
    # The file is off the disk and no bookkeeping brings it back, so the undo is
    # a re-download — which needs the whole metadata row, not just the id.
    assert removed["youtube_id"] == "vid1"
    assert removed["title"] == "A Video"
    assert removed["duration_seconds"] == 600
    assert (await client.get("/api/downloads")).json() == []


@pytest.mark.asyncio
async def test_deleting_what_is_not_there_hands_back_nothing(client):
    r = await client.delete("/api/downloads/vid1")
    assert r.json() == {"ok": True, "removed": None}
