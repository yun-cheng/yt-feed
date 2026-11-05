"""A finished stream's chat replay: what's kept of it, and the job that fetches it.

The replay is YouTube's JSON, a page per line, and the Chat tab wants a short
list of who said what when. What's pinned here is that trimming: the messages
it keeps and how, the ones it drops, and the progress it reads off a download
still under way. Then the endpoint's lifecycle, with the download faked.
"""

import asyncio
import json
import os
import shutil

import pytest

from app import live_chat
from app.config import settings
from app.routers import chat


def page(t_ms, *items):
    """One line of the raw replay: everything sent at `t_ms` into the stream."""
    return json.dumps({"replayChatItemAction": {
        "videoOffsetTimeMsec": str(t_ms),
        "actions": [{"addChatItemAction": {"item": item}} for item in items],
    }})


def text(name, *runs, badges=()):
    return {"liveChatTextMessageRenderer": {
        "authorName": {"simpleText": name},
        "message": {"runs": list(runs)},
        "authorBadges": [{"liveChatAuthorBadgeRenderer": b} for b in badges],
    }}


CUSTOM = {"emoji": {"emojiId": "UCx/abc", "isCustomEmoji": True, "shortcuts": [":hype:"],
                    "image": {"thumbnails": [{"url": "https://e/24"}, {"url": "https://e/48"}]}}}
STANDARD = {"emoji": {"emojiId": "🤣", "shortcuts": [":rofl:"],
                      "image": {"thumbnails": [{"url": "https://fonts.gstatic.com/x.png"}]}}}


def test_a_message_keeps_its_time_author_and_text_with_emoji_inline():
    got = live_chat.parse([page(61_500, text("@ann", {"text": "gg "}, STANDARD, {"text": " "}, CUSTOM))])

    # A standard emoji is its own character, joined into the text; a channel's
    # custom one is a picture, at the size YouTube offers last (the largest).
    assert got == [{"t": 61_500, "a": "@ann", "r": ["gg 🤣 ", {"e": "https://e/48", "n": ":hype:"}]}]


def test_a_role_that_changes_how_a_name_is_drawn_is_kept():
    got = live_chat.parse([
        page(1, text("@chan", {"text": "hi"}, badges=[{"icon": {"iconType": "OWNER"}}])),
        page(2, text("@mod", {"text": "hi"}, badges=[{"icon": {"iconType": "MODERATOR"}},
                                                     {"icon": {"iconType": "VERIFIED"}}])),
        page(3, text("@fan", {"text": "hi"}, badges=[{"customThumbnail": {"thumbnails": []}}])),
        page(4, text("@star", {"text": "hi"}, badges=[{"icon": {"iconType": "VERIFIED"}}])),
    ])

    assert [m.get("b") for m in got] == ["owner", "mod", "member", None]


def test_super_chats_and_new_members_come_through_and_the_rest_is_dropped():
    got = live_chat.parse([page(
        5_000,
        {"liveChatPaidMessageRenderer": {"authorName": {"simpleText": "@rich"},
                                         "purchaseAmountText": {"simpleText": "NT$150"}}},
        {"liveChatMembershipItemRenderer": {"authorName": {"simpleText": "@new"},
                                            "headerSubtext": {"runs": [{"text": "Welcome!"}]}}},
        {"liveChatPlaceholderItemRenderer": {"id": "x"}},
        {"liveChatViewerEngagementMessageRenderer": {"message": {"runs": [{"text": "Replay is on"}]}}},
        text("@empty"),
    )])

    # A Super Chat with no words still says something: its amount.
    assert got == [
        {"t": 5_000, "a": "@rich", "r": [], "p": "NT$150"},
        {"t": 5_000, "a": "@new", "r": ["Welcome!"], "m": True},
    ]


def test_messages_come_out_in_stream_order_whatever_order_the_pages_came_in():
    got = live_chat.parse([page(9, text("b", {"text": "2"})), "not json", page(3, text("a", {"text": "1"}))])

    assert [m["t"] for m in got] == [3, 9]


def test_progress_is_read_off_the_last_whole_page(tmp_path):
    part = tmp_path / "x.part"
    part.write_text(page(1_000, text("a", {"text": "x"})) + "\n"
                    + page(42_000, text("b", {"text": "y"})) + "\n"
                    + '{"replayChatItemAction": {"videoOffsetTim')  # still arriving

    assert live_chat.covered_ms(str(part)) == 42_000
    assert live_chat.covered_ms(str(tmp_path / "missing")) == 0


@pytest.mark.parametrize("info,offered", [
    ({"live_status": "was_live", "subtitles": {"live_chat": [{}]}}, True),
    ({"live_status": "was_live", "subtitles": {}}, False),  # chat was off
    ({"live_status": "is_live", "subtitles": {"live_chat": [{}]}}, False),  # never ends
    ({"live_status": "not_live", "subtitles": {"en": [{}]}}, False),
])
def test_the_tab_is_offered_only_for_a_finished_stream_with_chat(info, offered):
    assert live_chat.has_replay(info) is offered


# ── The endpoint ─────────────────────────────────────────────────────


VID = "abcdefghijk"


@pytest.fixture
def fresh():
    shutil.rmtree(settings.live_chat_dir, ignore_errors=True)
    chat._jobs.clear()
    chat._errors.clear()
    yield
    shutil.rmtree(settings.live_chat_dir, ignore_errors=True)


async def settle():
    while chat._jobs:
        await asyncio.sleep(0.01)


async def test_a_replay_is_fetched_once_and_then_served(client, fresh, monkeypatch):
    calls = []

    def fake_download(video_id, workdir):
        calls.append(video_id)
        os.makedirs(workdir, exist_ok=True)
        path = os.path.join(workdir, f"{video_id}.live_chat.json")
        with open(path, "w") as f:
            f.write(page(2_000, text("@ann", {"text": "first"})) + "\n")
        return path

    monkeypatch.setattr(live_chat, "download", fake_download)

    assert (await client.get(f"/api/chat/{VID}")).json() == {"status": "none"}
    r = await client.post(f"/api/chat/{VID}")
    assert r.json()["status"] in ("running", "done")
    await settle()

    done = (await client.get(f"/api/chat/{VID}")).json()
    assert done == {"status": "done", "messages": [{"t": 2_000, "a": "@ann", "r": ["first"]}]}
    # Kept: asking again serves the copy rather than fetching another.
    assert (await client.post(f"/api/chat/{VID}")).json()["status"] == "done"
    assert calls == [VID]
    # And the raw download is gone; only the trimmed copy stays.
    assert os.listdir(settings.live_chat_dir) == [f"{VID}.json"]


async def test_a_failed_fetch_says_why_and_can_be_tried_again(client, fresh, monkeypatch):
    def boom(video_id, workdir):
        raise RuntimeError("Sign in to confirm you're not a bot")

    monkeypatch.setattr(live_chat, "download", boom)
    await client.post(f"/api/chat/{VID}")
    await settle()

    r = (await client.get(f"/api/chat/{VID}")).json()
    assert r["status"] == "error" and "not a bot" in r["error"]

    monkeypatch.setattr(live_chat, "download", lambda v, w: (_ for _ in ()).throw(RuntimeError("again")))
    await client.post(f"/api/chat/{VID}")
    await settle()
    assert (await client.get(f"/api/chat/{VID}")).json()["error"] == "again"


@pytest.mark.parametrize("bad", ["short", "abc.efghijk", "abcdefghijkl"])
async def test_only_a_video_id_reaches_the_filesystem(client, fresh, bad):
    r = await client.post(f"/api/chat/{bad}")
    assert r.status_code == 404
