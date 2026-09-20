"""The caption menu's two facts: which languages a video offers, and which track
it opens with.

Deriving the list costs a yt-dlp extraction, so it is kept in SQLite. It used to
be kept forever, on the theory that a video's captions are fixed — but a creator
can upload a subtitle track months after publishing, and a row written before
that hid the new track for good. So the row is dated, and an old one is derived
again.

The second half is `_pick_track` with nothing asked for — the `native` track. A
creator's own upload order decides it, because YouTube often reports no language
at all for a video and guessing English there opened Chinese videos in English.
"""

import json
from datetime import datetime, timedelta

import pytest
from sqlalchemy import text

from app.models import CaptionLangs
from app.routers import feed

pytestmark = pytest.mark.asyncio


def tracks(monkeypatch, subs):
    """Stub the extraction, counting how often it is asked to run."""
    calls = []

    async def _fetch(video_id):
        calls.append(video_id)
        return subs, {}, None

    monkeypatch.setattr(feed, "_caption_tracks", _fetch)
    feed._ct_cache.clear()
    return calls


def json3(url="u"):
    return [{"ext": "json3", "url": url}]


async def langs_of(client, video_id="vid1"):
    return (await client.get(f"/api/feed/caption-langs/{video_id}")).json()


async def store(db, video_id, langs, native, age=timedelta(0)):
    db.add(CaptionLangs(
        video_id=video_id, langs=json.dumps(langs), native_lang=native,
        updated_at=datetime.utcnow() - age,
    ))
    await db.commit()


async def test_a_fresh_row_is_served_without_an_extraction(client, db, monkeypatch):
    calls = tracks(monkeypatch, {"en": json3()})
    await store(db, "vid1", [{"code": "zh", "label": "中文"}], "zh")

    assert (await langs_of(client))["langs"] == [{"code": "zh", "label": "中文"}]
    assert calls == []  # the point of the row


async def test_an_old_row_is_derived_again(client, db, monkeypatch):
    """The bug this file exists for: the creator added English subtitles after we
    had already written down "中文 only"."""
    tracks(monkeypatch, {"zh-CN": json3(), "en": json3()})
    await store(db, "vid1", [{"code": "zh", "label": "中文"}], "zh", age=timedelta(days=30))

    assert (await langs_of(client))["langs"] == [
        {"code": "en", "label": "English"}, {"code": "zh", "label": "中文"}]


async def test_the_refreshed_row_replaces_the_old_one(client, db, monkeypatch):
    calls = tracks(monkeypatch, {"zh-CN": json3(), "en": json3()})
    await store(db, "vid1", [{"code": "zh", "label": "中文"}], "zh", age=timedelta(days=30))
    await langs_of(client)

    db.expire_all()
    row = await db.get(CaptionLangs, "vid1")
    assert [l["code"] for l in json.loads(row.langs)] == ["en", "zh"]
    # And the fresh row is trusted again, so nothing is extracted a second time.
    derived = len(calls)
    await langs_of(client)
    assert len(calls) == derived


async def test_a_row_with_no_date_counts_as_old(client, db, monkeypatch):
    """Rows written before the column existed have no timestamp to judge."""
    tracks(monkeypatch, {"en": json3()})
    await store(db, "vid1", [], "")
    # The column has a default, so the NULL has to be written past the model.
    await db.execute(text("UPDATE caption_langs SET updated_at = NULL"))
    await db.commit()

    assert (await langs_of(client))["langs"] == [{"code": "en", "label": "English"}]


async def test_a_failed_refresh_keeps_the_list_we_had(client, db, monkeypatch):
    """YouTube throttling us must not empty the menu of a video we know about —
    and must not overwrite the row with nothing, either."""
    async def _fails(video_id):
        return None

    monkeypatch.setattr(feed, "_caption_tracks", _fails)
    feed._ct_cache.clear()
    await store(db, "vid1", [{"code": "en", "label": "English"}], "en", age=timedelta(days=30))

    body = await langs_of(client)
    assert body == {"langs": [{"code": "en", "label": "English"}], "native": "en"}

    db.expire_all()
    row = await db.get(CaptionLangs, "vid1")
    assert json.loads(row.langs) == [{"code": "en", "label": "English"}]


def json3_track(url="u"):
    return {"ext": "json3", "url": url}


async def test_the_first_uploaded_subtitle_is_the_native_one():
    """No language reported — which is the common case — so the creator's own
    order decides. This video is Chinese with an English subtitle alongside; it
    opens in Chinese."""
    subs = {"zh-CN": json3(), "en": json3()}
    assert feed._pick_track(subs, {}, None, "") == (json3_track(), "zh-CN")


async def test_the_videos_own_language_still_wins():
    """When YouTube does report one, upload order does not get a say."""
    subs = {"en": json3(), "ja": json3()}
    assert feed._pick_track(subs, {}, "ja", "")[1] == "ja"


async def test_a_subtitle_we_cannot_read_is_skipped():
    """A track with no json3 is not a track we can render, so the next one is
    the first — rather than falling through to the auto-captions."""
    subs = {"zh-CN": [{"ext": "vtt", "url": "u"}], "en": json3()}
    assert feed._pick_track(subs, {}, None, "")[1] == "en"


async def test_english_is_still_the_guess_among_auto_captions():
    """Where ASR is all there is, an unlabelled video is likelier English than
    whatever key the dict happens to start with."""
    auto = {"de": json3(), "en": json3()}
    assert feed._pick_track({}, auto, None, "")[1] == "en"
