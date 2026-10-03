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
import os
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

if "e2e" not in os.environ.get("DATA_DIR", ""):
    raise SystemExit("seed.py writes a feed: run it through e2e/serve.sh, never against real data")

from app.config import settings  # noqa: E402
from app.database import async_session, init_db  # noqa: E402
from app.models import Channel, Download, UserChannel, Video  # noqa: E402

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
    ]),
]

# Loose files for the local-folders spec: a directory the app is pointed at,
# not downloads it knows about.
LOCAL_FILES = [("Clip one.mp4", 8), ("Clip two.mp4", 5)]


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
            db.add(Channel(youtube_id=channel_id, title=channel_title))
            # Followed by user 1, whom the setup claim creates: the database
            # has no users yet, and SQLite doesn't hold the row to its key.
            db.add(UserChannel(user_id=1, channel_id=channel_id))
            for video_id, title, seconds, published, views, downloaded in videos:
                db.add(Video(
                    youtube_id=video_id, channel_id=channel_id, title=title,
                    published_at=published, duration_seconds=seconds,
                    view_count=views, like_count=views // 20,
                ))
                if not downloaded:
                    continue
                db.add(Download(
                    youtube_id=video_id, title=title, channel_id=channel_id,
                    channel_name=channel_title, duration_seconds=seconds,
                    published_at=published.isoformat(), status="ready",
                ))
                make_file(os.path.join(settings.downloads_dir, f"{video_id}.mp4"), seconds)
        await db.commit()

    media = Path(os.environ["E2E_MEDIA_DIR"])
    media.mkdir(parents=True, exist_ok=True)
    for name, seconds in LOCAL_FILES:
        make_file(str(media / name), seconds)


asyncio.run(main())
