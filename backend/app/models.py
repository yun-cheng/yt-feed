from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, BigInteger, Text, ForeignKey
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
    last_updated = Column(DateTime, default=datetime.utcnow)