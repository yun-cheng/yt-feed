from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, BigInteger, Text, ForeignKey, Float, Boolean
from app.database import Base


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
    # The video_labels.LABEL_VERSION the vocab was built with. When it's behind
    # the current version (e.g. after a prompt change), the channel is re-labeled
    # automatically on its next visit. NULL = pre-versioning / needs rebuild.
    video_label_version = Column(Integer, nullable=True)
    last_video_fetched = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class ChannelTag(Base):
    __tablename__ = "channel_tags"

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

    youtube_id = Column(String, primary_key=True)
    title = Column(String, nullable=False, default="")
    channel_id = Column(String, default="")
    channel_name = Column(String, default="")
    thumbnail_url = Column(String, default="")
    duration_seconds = Column(Integer, default=0)
    # Snapshot of the feed metadata so a reused VideoCard renders even after the
    # video ages out of the feed window.
    published_at = Column(String, default="")  # ISO string
    view_count = Column(BigInteger, default=0)
    like_count = Column(BigInteger, default=0)
    score = Column(Float, default=0.0)
    created_at = Column(DateTime, default=datetime.utcnow)


class Playlist(Base):
    """A user-created playlist (server-side)."""
    __tablename__ = "playlists"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
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

    channel_id = Column(String, primary_key=True)
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