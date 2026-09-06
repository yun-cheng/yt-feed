"""Summaries asked for from a card, and the notification that says they landed.

The interesting part isn't the model — it's stubbed here, as it is in test_ask.
It's that nobody is watching: the job row has to be written before the work
starts or a refreshed card has nothing to label itself with, the answer has to
end up in the Ask thread rather than a place the panel can't see, and a failure
has to become something the person who asked will actually be shown.
"""

import pytest

from app import llm, users
from app.models import User, Video

CUES = [
    {"start": 0, "dur": 3, "text": "Welcome back."},
    {"start": 3, "dur": 3, "text": "The pricing changed last month."},
]


def stub_captions(monkeypatch, cues):
    async def _cached(video_id, lang):
        return {"cues": cues, "lang": "en"} if cues else None
    monkeypatch.setattr("app.routers.ask._captions_cached", _cached)


def stub_model(monkeypatch, answer="A long summary of the whole thing.", boom=None):
    """The one-shot model the background job uses, or a failing one."""
    seen = {}

    def _chat(system, user, **kw):
        seen["system"] = system
        seen["user"] = user
        if boom:
            raise llm.LLMError(boom)
        return answer

    monkeypatch.setattr(llm, "chat", _chat)
    return seen


# ── starting one ─────────────────────────────────────────────────────


async def test_a_video_nobody_has_summarised_has_no_job(client):
    assert (await client.get("/api/summaries")).json() == {"jobs": []}
    assert (await client.get("/api/summaries/vid1")).status_code == 404


async def test_the_summary_lands_in_the_ask_thread(client, monkeypatch):
    """Not a table of its own: it IS an Ask answer, and the panel is where the
    reader will look for it — along with the question that produced it."""
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch)

    r = await client.post("/api/summaries/vid1")
    assert r.status_code == 200

    thread = (await client.get("/api/ask/vid1")).json()["messages"]
    assert [m["role"] for m in thread] == ["user", "assistant"]
    assert thread[1]["content"] == "A long summary of the whole thing."


async def test_the_question_asked_is_the_panel_s_own(client, monkeypatch):
    from app.routers.summaries import SUMMARY_QUESTIONS

    stub_captions(monkeypatch, CUES)
    seen = stub_model(monkeypatch)
    await client.post("/api/summaries/vid1")
    assert seen["user"] == SUMMARY_QUESTIONS["long"]
    # And the same system turn Ask builds, transcript and all.
    assert "The pricing changed last month." in seen["system"]


async def test_a_short_summary_asks_the_short_question(client, monkeypatch):
    """The two lengths are two different requests, not one request throttled —
    which is the whole reason both are offered from a card."""
    from app.routers.summaries import SUMMARY_QUESTIONS

    stub_captions(monkeypatch, CUES)
    seen = stub_model(monkeypatch)
    await client.post("/api/summaries/vid1", json={"length": "short"})
    assert seen["user"] == SUMMARY_QUESTIONS["short"]
    assert (await client.get("/api/summaries/vid1")).json()["length"] == "short"


async def test_asking_for_nothing_in_particular_gets_the_long_one(client, monkeypatch):
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch)
    await client.post("/api/summaries/vid1")
    assert (await client.get("/api/summaries/vid1")).json()["length"] == "long"


async def test_a_length_that_is_not_one_of_the_two_is_refused(client, monkeypatch):
    """Silently falling back to long would bill a 2,500-token answer for a typo."""
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch)
    r = await client.post("/api/summaries/vid1", json={"length": "medium"})
    assert r.status_code == 400
    assert (await client.get("/api/summaries/vid1")).status_code == 404


async def test_a_finished_job_reports_done(client, monkeypatch):
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch)
    await client.post("/api/summaries/vid1")

    job = (await client.get("/api/summaries/vid1")).json()
    assert job["status"] == "done"
    assert job["error"] == ""
    assert job["finished_at"]
    assert [j["video_id"] for j in (await client.get("/api/summaries")).json()["jobs"]] == ["vid1"]


async def test_a_video_without_a_transcript_fails_the_job_rather_than_the_request(
    client, monkeypatch,
):
    """The click already happened somewhere else. Refusing it with a 4xx would
    put the reason in a toast on a page nobody is on."""
    stub_captions(monkeypatch, [])
    stub_model(monkeypatch)

    r = await client.post("/api/summaries/vid1")
    assert r.status_code == 200

    job = (await client.get("/api/summaries/vid1")).json()
    assert job["status"] == "error"
    assert "transcript" in job["error"]
    assert (await client.get("/api/ask/vid1")).json()["messages"] == []


async def test_a_provider_failure_is_kept_on_the_job(client, monkeypatch):
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch, boom="provider went away")

    await client.post("/api/summaries/vid1")
    job = (await client.get("/api/summaries/vid1")).json()
    assert job["status"] == "error"
    assert job["error"] == "provider went away"


async def test_an_empty_reply_is_a_failure_not_a_summary(client, monkeypatch):
    """A blank assistant turn in the thread would read as "it had nothing to
    say about this video", which is a different claim from "it didn't answer"."""
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch, answer="   ")

    await client.post("/api/summaries/vid1")
    assert (await client.get("/api/summaries/vid1")).json()["status"] == "error"
    assert (await client.get("/api/ask/vid1")).json()["messages"] == []


async def test_summarising_again_replaces_the_job_rather_than_stacking_one(client, monkeypatch):
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch)
    await client.post("/api/summaries/vid1", json={"length": "short"})
    await client.post("/api/summaries/vid1", json={"length": "long"})

    jobs = (await client.get("/api/summaries")).json()["jobs"]
    assert len(jobs) == 1
    # The row says which one was asked for LAST — it is what the menu's spinner
    # and the card's label are about, not a record of everything ever run.
    assert jobs[0]["length"] == "long"
    # Two runs, two answers — the thread is a conversation, so it accumulates.
    assert len((await client.get("/api/ask/vid1")).json()["messages"]) == 4


async def test_forgetting_a_job_clears_the_label_and_keeps_the_summary(client, monkeypatch):
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch)
    await client.post("/api/summaries/vid1")

    await client.delete("/api/summaries/vid1")
    assert (await client.get("/api/summaries")).json() == {"jobs": []}
    assert len((await client.get("/api/ask/vid1")).json()["messages"]) == 2


# ── what it tells you afterwards ─────────────────────────────────────


async def test_finishing_raises_a_notification_naming_the_video(client, db, monkeypatch):
    import datetime

    db.add(Video(youtube_id="vid1", channel_id="ch1", title="A talk about pricing",
                 thumbnail_url="https://i.ytimg.com/vi/vid1/mqdefault.jpg",
                 published_at=datetime.datetime(2026, 1, 1)))
    await db.commit()
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch)

    await client.post("/api/summaries/vid1")
    data = (await client.get("/api/notifications")).json()
    assert data["unread"] == 1
    n = data["notifications"][0]
    assert n["kind"] == "summary"
    assert n["title"] == "Summary ready"
    assert n["body"] == "A talk about pricing"
    assert n["video_id"] == "vid1"
    # The cover is copied in at write time, so the row still renders after the
    # video leaves the library.
    assert n["thumbnail_url"] == "https://i.ytimg.com/vi/vid1/mqdefault.jpg"


async def test_a_failure_says_so_and_says_why(client, monkeypatch):
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch, boom="provider went away")

    await client.post("/api/summaries/vid1")
    n = (await client.get("/api/notifications")).json()["notifications"][0]
    assert n["kind"] == "summary_error"
    assert "provider went away" in n["body"]


@pytest.mark.no_seeded_user
async def test_a_summary_belongs_to_whoever_asked_for_it(client, db, monkeypatch):
    me = await users.ensure_local_user(db)
    them = User(google_sub="sub-2", email="them@example.test", api_key=users.new_api_key())
    db.add(them)
    await db.commit()
    mine = {"Authorization": f"Bearer {me.api_key}"}
    theirs = {"Authorization": f"Bearer {them.api_key}"}

    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch)
    await client.post("/api/summaries/vid1", headers=mine)

    assert (await client.get("/api/summaries", headers=theirs)).json() == {"jobs": []}
    assert (await client.get("/api/notifications", headers=theirs)).json()["unread"] == 0
    assert (await client.get("/api/ask/vid1", headers=theirs)).json()["messages"] == []


async def test_a_job_orphaned_by_a_restart_stops_claiming_to_be_running(client, db):
    """Nothing survives a server restart, and uvicorn's --reload does one most
    days. Without this the card says "Summarising" until someone notices."""
    import datetime

    from app.models import SummaryJob
    from app.routers.summaries import STALE_AFTER

    db.add(SummaryJob(
        user_id=1, video_id="vid1", status="running",
        created_at=datetime.datetime.utcnow() - STALE_AFTER - datetime.timedelta(minutes=1),
    ))
    await db.commit()

    job = (await client.get("/api/summaries/vid1")).json()
    assert job["status"] == "error"
    assert "interrupted" in job["error"]


async def test_a_stale_job_does_not_block_a_fresh_attempt(client, db, monkeypatch):
    import datetime

    from app.models import SummaryJob
    from app.routers.summaries import STALE_AFTER

    db.add(SummaryJob(
        user_id=1, video_id="vid1", status="running",
        created_at=datetime.datetime.utcnow() - STALE_AFTER - datetime.timedelta(minutes=1),
    ))
    await db.commit()
    stub_captions(monkeypatch, CUES)
    stub_model(monkeypatch)

    await client.post("/api/summaries/vid1")
    assert (await client.get("/api/summaries/vid1")).json()["status"] == "done"


# ── filtering a list down to what you've summarised ──────────────────


@pytest.fixture
async def a_library(db):
    """One followed channel, three videos, one of them summarised.

    Published now, so the feed's default age window can't be what excludes
    anything — the thing under test is the summary filter.
    """
    import datetime

    from app.models import Channel, SummaryJob

    db.add(Channel(youtube_id="chan1", title="A Channel"))
    for vid in ("done", "running", "plain"):
        db.add(Video(youtube_id=vid, channel_id="chan1", title=f"Video {vid}",
                     published_at=datetime.datetime.utcnow(), view_count=100))
    db.add(SummaryJob(user_id=1, video_id="done", status="done"))
    # Started but not landed: there's nothing to read yet, so it isn't one of
    # "the videos I have a summary for".
    db.add(SummaryJob(user_id=1, video_id="running", status="running"))
    await db.commit()

    user = await db.get(User, 1)
    await users.hold(db, user, "chan1")
    await db.commit()


def ids(payload):
    return {v["youtube_id"] for v in payload["videos"]}


async def test_the_feed_is_unfiltered_unless_asked(client, a_library):
    r = (await client.get("/api/tags/feed")).json()
    assert ids(r) == {"done", "running", "plain"}
    assert r["summarised"] is False


async def test_the_feed_can_show_only_what_has_a_summary(client, a_library):
    r = (await client.get("/api/tags/feed?summarised=true")).json()
    assert ids(r) == {"done"}
    assert r["summarised"] is True


async def test_the_count_matches_what_you_are_shown(client, a_library):
    """Filtered before ranking and paging, like the watch filter — a `total`
    counting videos that were then dropped promises pages that aren't there."""
    r = (await client.get("/api/tags/feed?summarised=true")).json()
    assert r["total"] == 1


async def test_a_channel_page_filters_the_same_way(client, a_library):
    r = (await client.get("/api/channels/chan1/videos?summarised=true")).json()
    assert ids(r) == {"done"}
    assert (await client.get("/api/channels/chan1/videos")).json()["total"] == 3


@pytest.mark.no_seeded_user
async def test_someone_else_s_summary_does_not_count_as_yours(client, db, monkeypatch):
    """The job table is per-user, and so is the filter reading it."""
    import datetime

    from app.models import Channel, SummaryJob
    from app.users import ensure_local_user

    me = await ensure_local_user(db)
    them = User(google_sub="sub-2", email="them@example.test", api_key=users.new_api_key())
    db.add(them)
    await db.commit()
    mine = {"Authorization": f"Bearer {me.api_key}"}

    db.add(Channel(youtube_id="chan1", title="A Channel"))
    db.add(Video(youtube_id="theirs", channel_id="chan1", title="Theirs",
                 published_at=datetime.datetime.utcnow(), view_count=100))
    db.add(SummaryJob(user_id=them.id, video_id="theirs", status="done"))
    await db.commit()
    await users.hold(db, me, "chan1")
    await db.commit()

    assert ids((await client.get("/api/tags/feed?summarised=true", headers=mine)).json()) == set()
    # …and without the filter it's still there, so this isn't just an empty feed.
    assert ids((await client.get("/api/tags/feed", headers=mine)).json()) == {"theirs"}
