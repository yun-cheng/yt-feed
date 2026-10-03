"""The e2e suite's feed: a channel or two per spec, and a folder of loose files.

The videos a spec opens are downloaded, so the watch page plays a file off
disk rather than the YouTube embed: a file plays the same way every run, needs
no network, and is what the bookmark, passage and chapter pictures are grabbed
from. The files are made here with ffmpeg — a test pattern with a running clock, a keyframe every second
so a seek lands where it's sent.

Run by serve.sh against the scratch DATA_DIR it exports; it refuses to run
against anything else.
"""

import asyncio
import json
import os
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

if "e2e" not in os.environ.get("DATA_DIR", ""):
    raise SystemExit("seed.py writes a feed: run it through e2e/serve.sh, never against real data")

from app.config import settings  # noqa: E402
from app.database import async_session, init_db  # noqa: E402
from app.models import (  # noqa: E402
    Channel, ChannelTag, Download, ImportedVideo, SummaryJob, UserChannel, UserImport,
    Video, WatchHistory, WatchLater,
)
from app.video_labels import LABEL_VERSION  # noqa: E402

# Days ago, so a seeded video is inside the feed's default time window (the
# last 3 days) whenever the suite runs — all but the one feed.spec widens to.
def ago(days: float) -> datetime:
    return datetime.utcnow() - timedelta(days=days)


# (channel id, channel title, [(video id, title, seconds, published, views,
# downloaded)]). Each spec has its own channel, so one spec's marks or history
# can't show up in another's — and up-next, which walks a channel forward in
# time, only finds a next video where a spec put one. A video that isn't
# downloaded would play through the YouTube embed, so specs only list those
# (the feed), never open them.
FEED = [
    ("UCe2eMarks0000000000000", "Marks Channel", [
        ("e2eMarks000", "Marks video", 20, ago(2), 100, True),
    ]),
    ("UCe2eLoop00000000000000", "Loop Channel", [
        ("e2eLoop0000", "Loop video", 20, ago(2), 100, True),
    ]),
    ("UCe2eEnding000000000000", "Ending Channel", [
        ("e2eEnding00", "Ending video", 6, ago(2.5), 100, True),
        ("e2eNextUp00", "The next one", 6, ago(2), 100, True),
    ]),
    ("UCe2eHistory00000000000", "History Channel", [
        ("e2eHist0000", "History video", 60, ago(2), 100, True),
    ]),
    ("UCe2ePlayer000000000000", "Player Channel", [
        ("e2ePlayer00", "Player video", 30, ago(2), 100, True),
    ]),
    ("UCe2eLibrary00000000000", "Library Channel", [
        ("e2eLibOne00", "Library one", 10, ago(2), 100, True),
        ("e2eLibTwo00", "Library two", 10, ago(1.5), 100, True),
    ]),
    ("UCe2eFeed00000000000000", "Feed Channel", [
        ("e2eFeedPop0", "Popular but older", 60, ago(5), 900_000, False),
        ("e2eFeedNew0", "Newer but quiet", 60, ago(1), 50, False),
        ("e2eShort000", "A short one", 30, ago(1), 100, False),
        ("e2eFeedHot0", "Viral today", 60, ago(0.1), 100_000, False),
        ("e2eFeedLove", "Loved but small", 60, ago(4), 1000, False),
        ("e2eFeedLike", "Liked a lot", 60, ago(6), 500_000, False),
    ]),
    ("UCe2eCooking00000000000", "Cooking Channel", [
        ("e2eSoup0000", "Soup in ten minutes", 400, ago(1), 5000, False),
        ("e2eSeen0000", "Seen it already", 120, ago(1), 100, False),
    ]),
    ("UCe2eHideable0000000000", "Hideable Channel", [
        ("e2eHideMe00", "Hide me", 60, ago(1), 100, False),
    ]),
    ("UCe2eTopics000000000000", "Topics Channel", [
        ("e2ePasta000", "Pasta at home", 60, ago(1), 100, False),
        ("e2eBread000", "Bread basics", 60, ago(2), 100, False),
        ("e2eKyoto000", "A week in Kyoto", 60, ago(3), 100, False),
    ]),
]

# Likes, where a twentieth of the views (the default) wouldn't tell the sorts
# apart. Over the last week each sort has its own leader: Views the old
# popular one, Hot the new one, Likes the well-liked one, Like% the small
# well-loved one.
LIKES = {"e2eFeedLove": 500, "e2eFeedLike": 100_000}

# A channel's video topics, as its page draws them: a vocabulary built at the
# current version, and each video's labels already assigned — so the page asks
# the model for nothing.
TOPICS = {"e2ePasta000": ["recipes"], "e2eBread000": ["recipes"], "e2eKyoto000": ["travel"]}
TOPIC_CHANNELS = {"UCe2eTopics000000000000": ["recipes", "travel"]}

# Lists the specs search in and take back from: two imported videos, and two
# in Watch Later. Those two are videos no spec opens: Watch Later hides the
# watched, and opening a short video at all can count as watching it.
IMPORTED = [("e2eImport00", "Imported clip"), ("e2eImport01", "Another import")]
WATCH_LATER = ["e2eFeedPop0", "e2eFeedHot0"]

# Vertical short-form: the Shorts feed, kept out of the Videos one.
SHORTS = {"e2eShort000"}

# The filters' material. A tag per channel for the sidebar's tag chips, the
# watch statuses (watched, in progress, and by omission unwatched — Home hides
# the watched by default, so only one video is), and one finished summary for
# the Summarised chip.
TAGS = {"UCe2eFeed00000000000000": "music", "UCe2eCooking00000000000": "food"}
HISTORY = {"e2eSeen0000": (120, True), "e2eSoup0000": (100, False)}  # position, watched
SUMMARISED = {"e2eSoup0000"}

# Loose files for the local-folders spec: a directory the app is pointed at,
# not downloads it knows about.
LOCAL_FILES = [("Clip one.mp4", 8), ("Clip two.mp4", 5)]


def thumbnail(video_id: str) -> str:
    """Where YouTube keeps a video's thumbnail. The specs' browser answers
    every request there with one picture made below (fixtures.ts), so a card
    looks as it does in use without anything leaving the machine."""
    return f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg"


def make_file(path: str, seconds: int) -> None:
    subprocess.run(
        [
            "ffmpeg", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc2=size=640x360:rate=25:duration={seconds}",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25",
            "-c:a", "aac", "-shortest", "-movflags", "+faststart",
            path,
        ],
        check=True,
    )


async def main() -> None:
    await init_db()
    Path(settings.downloads_dir).mkdir(parents=True, exist_ok=True)
    async with async_session() as db:
        for channel_id, channel_title, videos in FEED:
            vocab = TOPIC_CHANNELS.get(channel_id)
            db.add(Channel(
                youtube_id=channel_id, title=channel_title,
                video_label_vocab=json.dumps(vocab) if vocab else None,
                video_label_version=LABEL_VERSION if vocab else None,
            ))
            # Followed by user 1, whom the setup claim creates: the database
            # has no users yet, and SQLite doesn't hold the row to its key.
            db.add(UserChannel(user_id=1, channel_id=channel_id))
            if channel_id in TAGS:
                db.add(ChannelTag(user_id=1, channel_id=channel_id, tag_name=TAGS[channel_id]))
            for video_id, title, seconds, published, views, downloaded in videos:
                db.add(Video(
                    youtube_id=video_id, channel_id=channel_id, title=title,
                    thumbnail_url=thumbnail(video_id),
                    published_at=published, duration_seconds=seconds,
                    view_count=views, like_count=LIKES.get(video_id, views // 20),
                    is_short=video_id in SHORTS,
                    title_labels=json.dumps(TOPICS[video_id]) if video_id in TOPICS else None,
                ))
                if video_id in WATCH_LATER:
                    db.add(WatchLater(
                        user_id=1, youtube_id=video_id, title=title, channel_id=channel_id,
                        channel_name=channel_title, thumbnail_url=thumbnail(video_id),
                        duration_seconds=seconds, published_at=published.isoformat(),
                        view_count=views,
                    ))
                if video_id in HISTORY:
                    position, watched = HISTORY[video_id]
                    db.add(WatchHistory(
                        user_id=1, youtube_id=video_id, position_seconds=position,
                        duration_seconds=seconds, watched=watched, title=title,
                        channel_id=channel_id, channel_name=channel_title,
                        published_at=published.isoformat(),
                    ))
                if video_id in SUMMARISED:
                    db.add(SummaryJob(
                        user_id=1, video_id=video_id, status="done", length="short",
                        finished_at=datetime.utcnow(),
                    ))
                if not downloaded:
                    continue
                db.add(Download(
                    youtube_id=video_id, title=title, channel_id=channel_id,
                    thumbnail_url=thumbnail(video_id),
                    channel_name=channel_title, duration_seconds=seconds,
                    published_at=published.isoformat(), status="ready",
                ))
                make_file(os.path.join(settings.downloads_dir, f"{video_id}.mp4"), seconds)
        for video_id, title in IMPORTED:
            db.add(ImportedVideo(
                youtube_id=video_id, title=title, channel_name="Somewhere Else",
                thumbnail_url=thumbnail(video_id), duration_seconds=90,
                published_at=ago(1).isoformat(), view_count=10,
            ))
            db.add(UserImport(user_id=1, youtube_id=video_id))
        await db.commit()

    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi",
         "-i", "testsrc2=size=320x180", "-frames:v", "1", os.environ["E2E_THUMB"]],
        check=True,
    )

    media = Path(os.environ["E2E_MEDIA_DIR"])
    media.mkdir(parents=True, exist_ok=True)
    for name, seconds in LOCAL_FILES:
        make_file(str(media / name), seconds)


asyncio.run(main())
