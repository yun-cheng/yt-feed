import { useState, useEffect, useCallback, useRef } from 'react'
import TimeSortControls from './TimeSortControls'
import type { VideoItem } from '../App'
import VideoRow from './VideoRow'

type ChannelInfo = {
  youtube_id: string
  title: string
  description: string
  thumbnail_url: string
  subscriber_count: number
  tags: string[]
}

type ChannelResponse = {
  channel: ChannelInfo
  window: string
  sort: string
  videos: VideoItem[]
  total: number
}

type Props = {
  channelId: string
  timeWindow: string
  onTimeWindowChange: (w: string) => void
  sort: string
  onSortChange: (s: string) => void
  timeMode: string
  onTimeModeChange: (m: string) => void
  watchLaterIds?: Set<string>
  onToggleWatchLater?: (video: VideoItem) => void
  onDownload?: (video: VideoItem) => void
  downloadIds?: Set<string>
  onHideChannel?: (channelId: string) => void
  shorts?: boolean
}

function formatSubs(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

const CHANNEL_PAGE_SIZE = 60

export default function ChannelPage({ channelId, timeWindow, onTimeWindowChange, sort, onSortChange, timeMode, onTimeModeChange, watchLaterIds, onToggleWatchLater, onDownload, downloadIds, onHideChannel, shorts = false }: Props) {
  const [channel, setChannel] = useState<ChannelInfo | null>(null)
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const loadingMoreRef = useRef(false)

  // Fetch one page; append unless replacing.
  const fetchPage = useCallback(async (offset: number, replace: boolean) => {
    const params = new URLSearchParams({
      window: timeWindow, sort, time_mode: timeMode,
      shorts: String(shorts),
      offset: String(offset), limit: String(CHANNEL_PAGE_SIZE),
    })
    const res = await fetch(`/api/channels/${channelId}/videos?${params}`)
    if (!res.ok) throw new Error('Not found')
    const d: ChannelResponse = await res.json()
    setChannel(d.channel)
    setTotal(d.total || 0)
    setVideos((prev) => replace ? (d.videos || []) : [...prev, ...(d.videos || [])])
  }, [channelId, timeWindow, sort, timeMode, shorts])

  // Reset to the first page when the channel or filters change.
  useEffect(() => {
    let cancelled = false
    setLoading(true); setNotFound(false); setVideos([]); setTotal(0)
    fetchPage(0, true)
      .catch(() => { if (!cancelled) setNotFound(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchPage])

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || videos.length >= total) return
    loadingMoreRef.current = true
    try { await fetchPage(videos.length, false) }
    catch (e) { console.error('Failed to load more:', e) }
    finally { loadingMoreRef.current = false }
  }, [videos.length, total, fetchPage])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
        Loading...
      </div>
    )
  }

  if (notFound || !channel) {
    return (
      <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
        Channel not found.
      </div>
    )
  }

  const ch = channel

  return (
    <div className="px-6 py-4">
      {/* Channel header */}
      <div className="flex items-start gap-4 mb-6 pb-6 border-b border-[#272727]">
        <img
          src={ch.thumbnail_url}
          alt={ch.title}
          className="w-20 h-20 rounded-full object-cover bg-[#333] flex-shrink-0"
        />
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-white">{ch.title}</h2>
          <p className="text-sm text-[#777] mt-1">
            {formatSubs(ch.subscriber_count)} subscribers
          </p>
          {ch.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {ch.tags.map((tag) => (
                <span key={tag} className="px-2 py-0.5 text-[11px] bg-[#272727] text-[#999] rounded-full">
                  {tag}
                </span>
              ))}
            </div>
          )}
          {ch.description && (
            <p className="text-xs text-[#555] mt-2 line-clamp-2 leading-relaxed max-w-xl">
              {ch.description}
            </p>
          )}
          <a
            href={`https://www.youtube.com/channel/${ch.youtube_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-2 text-xs text-blue-400 hover:text-blue-300"
          >
            Open on YouTube →
          </a>
        </div>
      </div>


      {/* Video grid */}
      {videos.length === 0 ? (
        <div className="flex items-center justify-center h-32 text-[#aaaaaa] text-sm">
          No videos in this time range.
        </div>
      ) : (
        <VideoRow
          group={{ name: ch.title, icon: '', sort_order: 0, videos }}
          onChannelClick={(id) => window.open(`https://www.youtube.com/channel/${id}`, '_blank')}
          sort={sort}
          watchLaterIds={watchLaterIds}
          onToggleWatchLater={onToggleWatchLater}
          onDownload={onDownload}
          downloadIds={downloadIds}
          onHideChannel={onHideChannel}
          totalCount={total}
          onLoadMore={loadMore}
          hasMore={videos.length < total}
        />
      )}
    </div>
  )
}