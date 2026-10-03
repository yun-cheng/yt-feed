"""The e2e suite's feed: a few channels, each a video or two, every one downloaded.

Downloaded so the watch page plays a file off disk rather than the YouTube
embed: a file plays the same way every run, needs no network, and is what the
bookmark, passage and chapter pictures are grabbed from. The files are made
here with ffmpeg — a test pattern with a running clock, a keyframe every second
so a seek lands where it's sent.

Run by serve.sh against the scratch DATA_DIR it exports; it refuses to run
against anything else.
"""

import asyncio
import os
import subprocess
from datetime import datetime
from pathlib import Path

if "e2e" not in os.environ.get("DATA_DIR", ""):
    raise SystemExit("seed.py writes a feed: run it through e2e/serve.sh, never against real data")

from app.config import settings  # noqa: E402
from app.database import async_session, init_db  # noqa: E402
from app.models import Channel, Download, Video  # noqa: E402

# (channel id, channel title, [(video id, title, seconds, published)]). Each
# spec has its own channel, so one spec's marks or history can't show up in
# another's — and up-next, which walks a channel forward in time, only finds a
# next video where a spec put one.
FEED = [
    ("UCe2eMarks0000000000000", "Marks Channel", [
        ("e2eMarks000", "Marks video", 20, datetime(2026, 1, 1)),
    ]),
    ("UCe2eLoop00000000000000", "Loop Channel", [
        ("e2eLoop0000", "Loop video", 20, datetime(2026, 1, 1)),
    ]),
    ("UCe2eEnding000000000000", "Ending Channel", [
        ("e2eEnding00", "Ending video", 6, datetime(2026, 1, 1)),
        ("e2eNextUp00", "The next one", 6, datetime(2026, 1, 2)),
    ]),
]


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
            for video_id, title, seconds, published in videos:
                db.add(Video(
                    youtube_id=video_id, channel_id=channel_id, title=title,
                    published_at=published, duration_seconds=seconds,
                ))
                db.add(Download(
                    youtube_id=video_id, title=title, channel_id=channel_id,
                    channel_name=channel_title, duration_seconds=seconds,
                    published_at=published.isoformat(), status="ready",
                ))
                make_file(os.path.join(settings.downloads_dir, f"{video_id}.mp4"), seconds)
        await db.commit()


asyncio.run(main())
