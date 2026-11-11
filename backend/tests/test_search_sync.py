"""Keeping Meilisearch in step with the database without flooding it.

Every push waits in Meilisearch's queue as a file until it's indexed. A full
push of the corpus every scan, onto a queue that had stopped moving, once
filled the disk with a thousand copies of it. So a scan pushes only what it
touched, startup pushes only when the index is out of step, and nothing is
pushed onto a queue that isn't moving. Meilisearch is stubbed.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app import search_index
from app.models import Channel, Video

pytestmark = pytest.mark.asyncio


class FakeMeili:
    """Records each push, and answers the queue and stats questions."""

    def __init__(self):
        self.pushed: list[tuple[str, list]] = []
        self.deleted: list[tuple[str, list]] = []
        self.waiting = 0
        self.counts: dict[str, int] = {}
        self.held: dict[str, list[str]] = {"videos": [], "channels": []}
        self.asked: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, path, params=None):
        if path == "/tasks":
            self.asked.append(params)
            return _Reply({"total": self.waiting})
        uid = path.split("/")[2]
        if path.endswith("/documents"):
            start = params["offset"]
            page = self.held[uid][start:start + params["limit"]]
            return _Reply({"results": [{"youtube_id": i} for i in page]})
        return _Reply({"numberOfDocuments": self.counts.get(uid, 0)})

    async def post(self, path, json=None):
        if path.endswith("/delete-batch"):
            self.deleted.append((path.split("/")[2], json))
        else:
            self.pushed.append((path.split("/")[2], json))
        return _Reply({})

    def ids(self, index):
        return sorted(d["youtube_id"] for uid, docs in self.pushed if uid == index for d in docs)


class _Reply:
    status_code = 200

    def __init__(self, body):
        self.body = body

    def json(self):
        return self.body

    def raise_for_status(self):
        pass


@pytest.fixture
def meili(monkeypatch):
    fake = FakeMeili()

    async def client(timeout):
        return fake

    monkeypatch.setattr(search_index, "_client", client)
    return fake


@pytest.fixture
async def library(db):
    """One channel, a video the scan just refreshed and one it didn't touch."""
    now = datetime.now(timezone.utc)
    db.add(Channel(youtube_id="chan1", title="Cooking"))
    db.add(Video(youtube_id="fresh", channel_id="chan1", title="New pasta",
                 published_at=now, last_updated=now))
    db.add(Video(youtube_id="old", channel_id="chan1", title="Old pasta",
                 published_at=now - timedelta(days=400), last_updated=now - timedelta(days=30)))
    await db.commit()
    return now


async def test_a_scan_pushes_only_the_videos_it_touched(meili, library):
    counts = await search_index.index_changed_since(library - timedelta(minutes=1))
    assert meili.ids("videos") == ["fresh"]
    assert meili.ids("channels") == ["chan1"]
    assert counts == {"channels": 1, "videos": 1}


async def test_a_push_carries_the_channel_name(meili, library):
    await search_index.index_changed_since(library - timedelta(minutes=1))
    [(_, [doc])] = [p for p in meili.pushed if p[0] == "videos"]
    assert doc["channel_name"] == "Cooking"


async def test_nothing_goes_onto_a_queue_that_is_not_moving(meili, library):
    meili.waiting = search_index.MAX_WAITING
    await search_index.index_changed_since(library - timedelta(minutes=1))
    await search_index.reindex_all()
    await search_index.index_videos(["fresh"])
    assert meili.pushed == []


async def test_a_few_waiting_still_take_a_push(meili, library):
    meili.waiting = search_index.MAX_WAITING - 1
    await search_index.index_videos(["fresh"])
    assert meili.ids("videos") == ["fresh"]


async def test_startup_leaves_an_index_in_step_alone(meili, library):
    meili.counts = {"videos": 2, "channels": 1}
    assert await search_index.reindex_if_out_of_step() is None
    assert meili.pushed == []


async def test_startup_rebuilds_an_index_out_of_step(meili, library):
    meili.counts = {"videos": 1, "channels": 1}
    assert await search_index.reindex_if_out_of_step() == {"channels": 1, "videos": 2}
    assert meili.ids("videos") == ["fresh", "old"]


async def test_only_pushes_count_as_waiting(meili, library):
    """ensure_indexes queues settings tasks just before the startup reindex;
    they're not files on disk, and mustn't hold the reindex back."""
    await search_index.index_videos(["fresh"])
    assert meili.asked[-1]["types"] == "documentAdditionOrUpdate"


async def test_a_full_reindex_takes_out_what_the_database_no_longer_has(meili, library, monkeypatch):
    monkeypatch.setattr(search_index, "_ID_PAGE", 2)  # so it pages
    meili.held = {"videos": ["fresh", "gone1", "old", "gone2", "gone3"], "channels": ["chan1", "chanX"]}
    await search_index.reindex_all()
    assert dict(meili.deleted) == {"channels": ["chanX"], "videos": ["gone1", "gone2", "gone3"]}


async def test_a_full_reindex_of_an_index_in_step_deletes_nothing(meili, library):
    meili.held = {"videos": ["fresh", "old"], "channels": ["chan1"]}
    await search_index.reindex_all()
    assert meili.deleted == []
