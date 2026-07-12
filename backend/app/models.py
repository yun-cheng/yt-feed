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
    last_video_fetched = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Tag(Base):
    __tablename__ = "tags"

    name = Column(String, primary_key=True)
    icon = Column(String, default="")


class ChannelTag(Base):
    __tablename__ = "channel_tags"

    channel_id = Column(String, ForeignKey("channels.youtube_id"), primary_key=True)
    tag_name = Column(String, ForeignKey("tags.name"), primary_key=True)
    auto_assigned = Column(Integer, default=1)  # boolean


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
    last_updated = Column(DateTime, default=datetime.utcnow)