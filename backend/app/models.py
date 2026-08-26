from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, BigInteger, Text, ForeignKey, Float, Boolean, UniqueConstraint
from app.database import Base


class User(Base):
    """A person with their own subscriptions, history and preferences.

    The app was single-user for its whole life, so every other table here is
    keyed by a YouTube id alone. These two tables are the seam being opened:
    they carry who follows what, and everything personal is keyed by `id` as it
    moves across (see app/users.py).

    One box, a few trusted people — which is why there is no role column and no
    password. Two ways in, and which you use is decided by where the app is
    reached from rather than by preference: **Google** for whoever runs it, on
    localhost, and a **login link** for everyone else, because Google will only
    accept an http callback on localhost and a home server answers at
    192.168.something. Everyone who gets in is equally trusted with the downloads
    and local folders on the shared disk.
    """

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Google's stable per-account identifier — the `sub` claim of the id_token.
    # Empty on exactly one row: the local user the migration seeds from the
    # pre-accounts token file, which the first Google sign-in adopts rather than
    # duplicating. See `adopt_or_create` in app/users.py.
    google_sub = Column(String, default="", nullable=False, index=True)
    email = Column(String, default="", nullable=False)
    name = Column(String, default="")
    avatar_url = Column(String, default="")

    # What the browser extension authenticates with. A session cookie can't do
    # this job: the extension's worker posts from a youtube.com page context, so
    # a cookie would need SameSite=None and therefore HTTPS — a lot of ceremony
    # for a localhost app. A bearer token has neither constraint.
    api_key = Column(String, unique=True, nullable=False)

    # How someone signs in WITHOUT Google: a link containing this token, sent to
    # them once. Google is not an option for the rest of the household — it only
    # accepts an http callback on localhost, and a home server is reached at
    # 192.168.something — so for a family on a LAN this is the way in, and a link
    # is the least ceremony a sign-in can have.
    #
    # Durable rather than single-use, deliberately: the same link has to work on
    # a phone and a laptop, and again after a cleared cookie jar. It is
    # therefore a credential — regenerate it (POST /api/users/{id}/link) and the
    # old one stops working, which is the revocation.
    login_token = Column(String, unique=True, nullable=True, index=True)

    # Per-user OAuth, replacing the single config/youtube_oauth_token.json. The
    # refresh token is the durable half; the access token is cheap to re-mint and
    # deliberately not stored.
    refresh_token = Column(Text, default="")
    # What was granted, so the sign-in flow can tell a pre-accounts token (which
    # carries YouTube access but never asked who you are) from a current one.
    token_scopes = Column(Text, default="")

    # When this person's subscriptions were last reconciled against YouTube.
    # subscriptions.yaml's mtime used to be this clock, which only ever worked
    # because there was one list. See `_seconds_until_resync_due` in main.py.
    last_resync_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)


class UserChannel(Base):
    """Who follows which channel.

    Two things collapse into this table. subscriptions.yaml, which was one
    person's list living in a global file; and `Channel.source`, which recorded
    "I added this one by hand" — always a fact about a person rather than about
    the channel, and unanswerable once two people disagree.

    The channel row itself stays shared. That's the whole reason multi-user is
    worth doing rather than running the app twice: three people subscribed to the
    same channel cost one row, one fetch and one tagging bill, so quota is spent
    per distinct channel rather than per person.
    """

    __tablename__ = "user_channels"

    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    channel_id = Column(String, ForeignKey("channels.youtube_id"), primary_key=True)
    # "subscription" (it came from your YouTube subscriptions) or "manual" (you
    # added it by hand). Resync deletes memberships that aren't in your live
    # list, and a hand-added one never will be.
    source = Column(String, nullable=False, default="subscription")
    added_at = Column(DateTime, default=datetime.utcnow)


class Channel(Base):
    __tablename__ = "channels"

    youtube_id = Column(String, primary_key=True)
    title = Column(String, nullable=False)
    description = Column(Text, default="")
    thumbnail_url = Column(String, default="")
    subscriber_count = Column(Integer, default=0)
    group_name = Column(String, default="")  # legacy, will be replaced by tags
    # JSON list of YouTube topicDetails categories (e.g. ["Sport", "Baseball"]).
    # A hint fed to the LLM tagger.
    topics = Column(Text, default="")
    # Cached LLM tagging verdict: {"main": [...], "suggested": [...]}. Stored so
    # re-tagging and suggestion lookups don't re-hit the API on every request.
    llm_labels = Column(Text, default="")
    # Per-channel video-label vocabulary: JSON list of labels the LLM extracted
    # from this channel's video titles (e.g. ["baseball","football","MLB"] or
    # ["T1","HLE","BLG"]). These are the filter chips shown on the channel page.
    # NULL = not built yet (built once, lazily, on first channel-page view).
    video_label_vocab = Column(Text, nullable=True)
    # Labels this channel must never produce, as a JSON list. Its own subject
    # ("League of Legends" on an LoL channel, "anime" on an anime channel) is a
    # label every one of its videos would carry, which makes it a chip that
    # filters nothing and a slot spent saying what you already knew. Seeded
    # automatically — the channel's taxonomy tags, plus any label a build found
    # on nearly every video — and meant to be user-editable later.
    label_stop_words = Column(Text, nullable=True)
    # The video_labels.LABEL_VERSION the vocab was built with. When it's behind
    # the current version (e.g. after a prompt change), the channel is re-labeled
    # automatically on its next visit. NULL = pre-versioning / needs rebuild.
    video_label_version = Column(Integer, nullable=True)
    # How this channel got here: "subscription" (it came from your YouTube
    # subscriptions) or "manual" (you added it by hand). The distinction exists
    # for exactly one reason — resync deletes every channel that isn't in your
    # live subscription list, and a hand-added one never will be. See
    # _prune_channels' caller in routers/subscriptions.py.
    source = Column(String, nullable=False, default="subscription", server_default="subscription")
    last_video_fetched = Column(DateTime, nullable=True)

    # --- Archive fill (app/archive.py) ---
    # Where the uploads-playlist walk stopped. A page token is a self-contained
    # cursor: store it, come back in another process days later, and paging
    # resumes exactly where it left off. NULL = never walked / start at the top.
    archive_cursor = Column(String, nullable=True)
    # The walk ran out of pages: we hold this channel's whole fetchable history
    # and there is nothing left to ask for.
    archive_exhausted = Column(Boolean, nullable=False, default=False, server_default="0")
    # Lifetime uploads as YouTube reports them, cached so the UI can say
    # "3,260 of 8,917" without a request per render. Note this is the channel's
    # TRUE count, which can exceed what the uploads playlist will hand over —
    # see ARCHIVE_CEILING.
    lifetime_count = Column(Integer, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)


class AppSetting(Base):
    """A preference belonging to the DEPLOYMENT, not to a person.

    What's left here after accounts arrived: the switches that govern shared
    resources, where one person's answer decides the group's. `archive_fill_enabled`
    is the case in point — it spends a daily API quota billed to one Cloud project,
    so a per-person copy would let whoever flipped it last commit everybody's.

    See app/app_settings.py, whose SPEC marks each key `scope="app"` or
    `scope="user"` and routes it here or to UserSetting accordingly.
    """

    __tablename__ = "app_settings"

    key = Column(String, primary_key=True)
    value = Column(String, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class UserSetting(Base):
    """A preference belonging to one person.

    A separate table rather than a `user_id` bolted onto `app_settings`: the two
    kinds answer different questions ("what does this machine do" vs "what do I
    want"), and keeping them apart means neither needs a sentinel row to say
    which it is.
    """

    __tablename__ = "user_settings"

    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    key = Column(String, primary_key=True)
    value = Column(String, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class QuotaLedger(Base):
    """Data API units spent, per YouTube quota-day (midnight US/Pacific).

    One row per day. Persisted because a budget that resets when the process
    does is not a budget — see app/quota.py.
    """

    __tablename__ = "quota_ledger"

    quota_day = Column(String, primary_key=True)  # ISO date in US/Pacific
    units = Column(Integer, nullable=False, default=0)
    archive_units = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ChannelTag(Base):
    __tablename__ = "channel_tags"

    # A tag is an opinion about a channel, not a property of it: two people can
    # file the same channel differently, and the sidebar each of them sees is
    # built from their own.
    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    channel_id = Column(String, ForeignKey("channels.youtube_id"), primary_key=True)
    # The taxonomy lives in code (SEED_TAXONOMY in routers/tags.py), not a DB
    # table — so tag_name is a plain string, not an FK. A ForeignKey("tags.name")
    # here has no table to resolve and makes every insert flush 500.
    tag_name = Column(String, primary_key=True)
    auto_assigned = Column(Integer, default=1)  # boolean


class ChannelTagRejection(Base):
    """An auto-derived tag the user removed from a channel.

    Kept out of `channel_tags` on purpose: every query there reads "a row exists"
    as "the channel has this tag" (feed filters, sidebar counts), so a tombstone
    living in that table would leak into all of them. Instead, re-tagging skips
    these, and they resurface as suggestions so the user can put them back.
    """
    __tablename__ = "channel_tag_rejections"

    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    channel_id = Column(String, primary_key=True)
    tag_name = Column(String, primary_key=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class CaptionTranslation(Base):
    """LLM translations of one video's captions, stored SPARSELY.

    Translation runs a block at a time as playback approaches it (like video
    buffering), so a video is usually only partly translated — `lines` is a JSON
    map of {cue index: translated text} that each block merges into, rather than
    a whole-video blob. Worth persisting at all because, unlike the other caption
    caches (in-memory, TTL'd), a rebuild costs real tokens.

    Keyed by the SOURCE track — translating a video's English vs. its Japanese
    track gives different results — with the target language recorded alongside
    so a future second target doesn't collide.
    """
    __tablename__ = "caption_translations"

    video_id = Column(String, primary_key=True)
    src_lang = Column(String, primary_key=True, default="")  # "" = the native track
    target_lang = Column(String, primary_key=True, default="zh-Hant")
    lines = Column(Text, nullable=False, default="{}")  # JSON {"<cue index>": "text"}
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class CaptionLangs(Base):
    """Which caption languages a video offers, and which track is its native one.

    Persisted because deriving it costs a yt-dlp extraction (~1s idle, worse when
    the preview pool is busy), and the watch page's caption menu can't render its
    "Second subtitles" section until it lands. The in-memory cache already covers
    a session; this survives restarts, and a video's caption languages never
    change, so there's nothing to invalidate.

    Deliberately NOT the raw track info: that's ~512KB of JSON per video, and
    every URL in it is signed with a ~7h expiry, so it would be both fat and
    stale. These derived codes are a few dozen bytes and immutable.
    """
    __tablename__ = "caption_langs"

    video_id = Column(String, primary_key=True)
    langs = Column(Text, nullable=False, default="[]")  # JSON [{"code","label"}, …]
    native_lang = Column(String, default="")  # base code of the track served by default
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Download(Base):
    """A video the user has downloaded for offline viewing (server-side file)."""
    __tablename__ = "downloads"

    youtube_id = Column(String, primary_key=True)
    title = Column(String, nullable=False, default="")
    channel_id = Column(String, default="")
    channel_name = Column(String, default="")
    channel_thumbnail = Column(String, default="")
    thumbnail_url = Column(String, default="")
    duration_seconds = Column(Integer, default=0)
    # Snapshot of the feed metadata so a reused VideoCard renders faithfully.
    published_at = Column(String, default="")  # ISO string
    view_count = Column(BigInteger, default=0)
    like_count = Column(BigInteger, default=0)
    score = Column(Float, default=0.0)
    status = Column(String, default="downloading")  # downloading | ready | error
    error = Column(Text, default="")
    filesize = Column(BigInteger, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class WatchLater(Base):
    """A video the user saved to watch later (server-side, syncs across devices)."""
    __tablename__ = "watch_later"

    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    youtube_id = Column(String, primary_key=True)
    title = Column(String, nullable=False, default="")
    channel_id = Column(String, default="")
    channel_name = Column(String, default="")
    channel_thumbnail = Column(String, default="")
    thumbnail_url = Column(String, default="")
    duration_seconds = Column(Integer, default=0)
    # Snapshot of the feed metadata so a reused VideoCard renders even after the
    # video ages out of the feed window.
    published_at = Column(String, default="")  # ISO string
    view_count = Column(BigInteger, default=0)
    like_count = Column(BigInteger, default=0)
    score = Column(Float, default=0.0)
    created_at = Column(DateTime, default=datetime.utcnow)


class WatchHistory(Base):
    """How far you got in a video, and whether you finished it.

    One row per video ever opened in the watch page, written every few seconds
    while it plays. `position_seconds` is what makes a revisit resume where you
    stopped, and what draws the red progress bar on the card before you hover.

    Carries the same metadata snapshot as WatchLater so the History page renders
    a card for a video that has since aged out of the feed — or was never in it
    (an imported one-off).
    """
    __tablename__ = "watch_history"

    # First in the key because every query filters on it: "my history", "my
    # position in this video". A video id alone stopped identifying a row the
    # moment two people could watch the same video.
    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    youtube_id = Column(String, primary_key=True)
    position_seconds = Column(Float, nullable=False, default=0.0)
    # The player's own duration, which is authoritative — the feed's copy can be
    # missing (0) on a video we only ever saw through a snapshot.
    duration_seconds = Column(Integer, nullable=False, default=0)
    # Sticky: once you've reached the end it stays set, so a rewatch that stops
    # halfway doesn't un-finish the video.
    watched = Column(Boolean, nullable=False, default=False, server_default="0")

    title = Column(String, nullable=False, default="")
    channel_id = Column(String, default="")
    channel_name = Column(String, default="")
    channel_thumbnail = Column(String, default="")
    thumbnail_url = Column(String, default="")
    published_at = Column(String, default="")  # ISO string
    view_count = Column(BigInteger, default=0)
    like_count = Column(BigInteger, default=0)
    is_short = Column(Boolean, nullable=False, default=False, server_default="0")
    score = Column(Float, default=0.0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class ImportedVideo(Base):
    """A one-off video the user imported by pasting its URL.

    Kept out of `videos` on purpose: every feed query joins that table to the
    SUBSCRIBED channel set (see routers/tags.feed_by_tags), and an imported
    video's channel has no `channels` row — so a row there would be invisible
    anyway, while polluting the scan/ranking paths. Instead this holds its own
    metadata snapshot (like WatchLater / Download), fetched once at import time
    via yt-dlp, which the same VideoCard renders.
    """
    __tablename__ = "imported_videos"

    youtube_id = Column(String, primary_key=True)
    title = Column(String, nullable=False, default="")
    channel_id = Column(String, default="")
    channel_name = Column(String, default="")
    channel_thumbnail = Column(String, default="")
    thumbnail_url = Column(String, default="")
    duration_seconds = Column(Integer, default=0)
    published_at = Column(String, default="")  # ISO string
    view_count = Column(BigInteger, default=0)
    like_count = Column(BigInteger, default=0)
    is_short = Column(Boolean, nullable=False, default=False, server_default="0")
    score = Column(Float, default=0.0)
    created_at = Column(DateTime, default=datetime.utcnow)
    # How the row got here. "import" = you pasted its link and meant to keep it,
    # and those are the only ones the Imported page lists. "youtube" = you opened
    # it with the extension's button and this is just the metadata the watch page
    # and history need; see routers/feed.get_video.
    source = Column(String, nullable=False, default="import", server_default="import")


class UserImport(Base):
    """Who pasted which video in.

    `imported_videos` does two jobs: it's a metadata snapshot for videos the
    feed doesn't hold, AND it was the list of what you imported. The first is a
    cache and shared — the same video costs one yt-dlp fetch however many people
    paste it. The second is personal, so it moved here.

    A membership table rather than a `user_id` on the snapshot, for the reason
    the snapshot's own primary key makes plain: a video is one row, and two
    people importing it would otherwise fight over who owns it — the second
    quietly taking it off the first's page.
    """

    __tablename__ = "user_imports"

    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    youtube_id = Column(String, primary_key=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class LocalFolder(Base):
    """A directory on this machine watched as its own feed.

    Only the path is user-supplied; everything under it is discovered by scanning
    (see routers/local.py). Kept as separate rows rather than one big "local
    videos" pile so each folder is its own page — a folder is the unit you added,
    and the unit you remove.
    """
    __tablename__ = "local_folders"

    id = Column(Integer, primary_key=True, autoincrement=True)
    path = Column(String, nullable=False, unique=True)  # absolute, resolved
    name = Column(String, default="")  # defaults to the directory's own name
    created_at = Column(DateTime, default=datetime.utcnow)


class LocalVideo(Base):
    """One video file inside a LocalFolder.

    A cache of what a scan found, not a source of truth: the files on disk are.
    It exists because the two things a card needs — duration and a poster frame —
    each cost an ffmpeg/ffprobe run, and re-deriving them on every page view would
    make a folder of thirty clips unusable. `mtime`/`filesize` are how a rescan
    tells an unchanged file (keep the cached duration) from a replaced one.

    `position_seconds`/`watched` are the same resume behaviour the YouTube side
    gets from watch_history, kept here instead: history is keyed by youtube_id
    and its page renders YouTube cards, and a file on disk is neither.
    """
    __tablename__ = "local_videos"

    # sha1(folder id + relative path) — stable across rescans, and safe in a URL.
    id = Column(String, primary_key=True)
    folder_id = Column(Integer, ForeignKey("local_folders.id"), index=True, nullable=False)
    rel_path = Column(String, nullable=False)  # relative to the folder's path
    title = Column(String, default="")  # the file name without its extension
    duration_seconds = Column(Integer, default=0)
    # False until ffprobe has read this file. Its own flag rather than
    # `duration_seconds == 0` because probing can legitimately come back with
    # nothing (an unreadable file), and retrying that on every page view would
    # re-stream it from the cloud forever.
    probed = Column(Boolean, nullable=False, default=False, server_default="0")
    filesize = Column(BigInteger, default=0)
    mtime = Column(Float, default=0.0)
    position_seconds = Column(Float, nullable=False, default=0.0)
    watched = Column(Boolean, nullable=False, default=False, server_default="0")
    created_at = Column(DateTime, default=datetime.utcnow)


class Playlist(Base):
    """A user-created playlist (server-side)."""
    __tablename__ = "playlists"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # `playlist_items` needs none of its own — an item belongs to whoever owns
    # the playlist it's in, and a second copy of that could disagree with it.
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False, default=1)
    name = Column(String, nullable=False)
    # The YouTube playlist this one was imported from, empty for a playlist made
    # here. Kept so a re-sync knows what to ask for — and so importing the same
    # playlist twice lands in the copy you already have rather than beside it.
    #
    # Not unique: two people may each import the same public playlist, and the
    # same person may deliberately keep a linked copy and a divergent one.
    youtube_id = Column(String, default="", nullable=False, index=True)
    synced_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class PlaylistItem(Base):
    """A video in a playlist. Stores a metadata snapshot like WatchLater."""
    __tablename__ = "playlist_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    playlist_id = Column(Integer, ForeignKey("playlists.id"), index=True, nullable=False)
    youtube_id = Column(String, nullable=False, index=True)
    title = Column(String, default="")
    channel_id = Column(String, default="")
    channel_name = Column(String, default="")
    channel_thumbnail = Column(String, default="")
    thumbnail_url = Column(String, default="")
    duration_seconds = Column(Integer, default=0)
    published_at = Column(String, default="")  # ISO string
    view_count = Column(BigInteger, default=0)
    like_count = Column(BigInteger, default=0)
    score = Column(Float, default=0.0)
    added_at = Column(DateTime, default=datetime.utcnow)


class HiddenChannel(Base):
    """A channel the user hid from the home feed (server-side, so it syncs across
    devices — unlike the old localStorage version)."""
    __tablename__ = "hidden_channels"

    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    channel_id = Column(String, primary_key=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Bookmark(Base):
    """A moment in a video the user marked while watching (the `b` shortcut).

    `video_id` is deliberately untyped and unconstrained: the watch page plays a
    YouTube video, a downloaded copy of one, or a file from a local folder, and
    the first two share the YouTube id while the third uses the LocalVideo hash.
    All three are opaque strings from here, so one table covers every source
    without a per-source column or a join that would differ by source.

    Many rows per video, ordered by position — unlike WatchHistory's single
    upserted row, a bookmark is an event, and the whole point is keeping several.
    """
    __tablename__ = "bookmarks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # A plain column rather than part of the key: the id is already unique, so
    # this only ever narrows a query.
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False, default=1)
    video_id = Column(String, nullable=False, index=True)
    position_seconds = Column(Float, nullable=False, default=0.0)
    note = Column(String, nullable=False, default="")
    created_at = Column(DateTime, default=datetime.utcnow)


class ChatMessage(Base):
    """One turn of the Ask conversation about a video.

    `video_id` is untyped and unconstrained for the same reason Bookmark's is:
    the watch page plays a YouTube video, a downloaded copy, or a file from a
    local folder, and one opaque string covers all three.

    Rows rather than a single blob per conversation, because the panel appends
    as it streams and the reply has to survive the tab closing mid-answer — a
    blob would have to be rewritten whole on every token to promise that.

    Kept per user: the same video holds a different conversation for each person
    in the house, and a question is a more personal thing than a bookmark.
    """

    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False, default=1)
    video_id = Column(String, nullable=False, index=True)
    # "user" or "assistant". The system turn is rebuilt from the transcript on
    # every request rather than stored: the transcript can improve (a better
    # track, a fixed parse), and a stored copy would pin the conversation to
    # whatever it looked like on the day it started.
    role = Column(String, nullable=False)
    content = Column(Text, nullable=False, default="")
    created_at = Column(DateTime, default=datetime.utcnow)


class SummaryJob(Base):
    """A long summary of a video, asked for from a card and written in the background.

    One row per (user, video) rather than one per run: re-summarising replaces
    the previous attempt, because nobody wants a history of summaries — they
    want the current one, and the answer itself lives in `chat_messages` where
    the Ask panel already reads it.

    The row exists so the card can say what is happening. The summary is written
    without anyone watching, which means the only thing that can report progress
    is state the server wrote down.
    """

    __tablename__ = "summary_jobs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False, default=1)
    video_id = Column(String, nullable=False, index=True)
    # "running" | "done" | "error". A row is created at "running" before the
    # first token is asked for, so a card labels itself the moment you click.
    status = Column(String, nullable=False, default="running")
    # "short" | "long" — which of the Ask panel's two summaries was asked for.
    # Kept so the menu can put its spinner on the entry that is actually running,
    # rather than on both.
    length = Column(String, nullable=False, default="long")
    error = Column(String, nullable=False, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)

    __table_args__ = (UniqueConstraint("user_id", "video_id", name="uq_summary_job_user_video"),)


class Notification(Base):
    """Something that finished while you were looking elsewhere.

    Today only summaries produce these, but the table is deliberately generic
    (`kind`, `title`, `body`, optional `video_id`) because everything else this
    app does in the background — downloads, imports, a resync — has the same
    shape and the same problem: it ends on a page you are not on.

    Read state is a flag rather than a per-user cursor: the bell shows a count,
    and a count needs to survive the tab being closed.
    """

    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False, default=1)
    kind = Column(String, nullable=False, default="summary")
    title = Column(String, nullable=False, default="")
    body = Column(String, nullable=False, default="")
    # Empty for a notification about nothing in particular; when set, clicking
    # the row opens that video.
    video_id = Column(String, nullable=False, default="", index=True)
    # Copied in at write time rather than looked up on read: the row has to
    # still render after the video is unsubscribed, hidden or dropped from the
    # library, and a thumbnail is the fastest way to recognise which video this
    # is about — faster than the title it sits beside.
    thumbnail_url = Column(String, nullable=False, default="")
    read = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class Video(Base):
    __tablename__ = "videos"

    youtube_id = Column(String, primary_key=True)
    channel_id = Column(String, nullable=False, index=True)
    title = Column(String, nullable=False)
    description = Column(Text, default="")
    thumbnail_url = Column(String, default="")
    published_at = Column(DateTime, nullable=False, index=True)
    duration_seconds = Column(Integer, default=0)
    view_count = Column(BigInteger, default=0)
    like_count = Column(BigInteger, default=0)
    comment_count = Column(BigInteger, default=0)
    # True for videos pulled from the channel's /shorts tab (vertical short-form).
    is_short = Column(Boolean, nullable=False, default=False, server_default="0", index=True)
    # JSON list of channel-specific labels drawn from this video's title (from the
    # channel's video_label_vocab). NULL = not labeled yet; labels are assigned
    # lazily, only for videos actually rendered on the channel page.
    title_labels = Column(Text, nullable=True)
    last_updated = Column(DateTime, default=datetime.utcnow)