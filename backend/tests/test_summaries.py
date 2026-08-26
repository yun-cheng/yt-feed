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
