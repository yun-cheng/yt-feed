import { useState, useEffect } from 'react'
import { useInView } from 'react-intersection-observer'
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
  onBack: () => void
  timeWindow: string
  onTimeWindowChange: (w: string) => void
  sort: string
  onSortChange: (s: string) => void
  onControlsScrolledAway?: (scrolledAway: boolean) => void
}

function formatSubs(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

export default function ChannelPage({ channelId, onBack, timeWindow, onTimeWindowChange, sort, onSortChange, onControlsScrolledAway }: Props) {
  const [data, setData] = useState<ChannelResponse | null>(null)
  const [loading, setLoading] = useState(true)

  // Sentinel: detect when page-level controls scroll out of view
  const { ref: sentinelRef, inView } = useInView({ threshold: 0, initialInView: true })

  useEffect(() => {
    onControlsScrolledAway?.(!inView)
  }, [inView, onControlsScrolledAway])

  useEffect(() => {
    fetchChannel()
  }, [channelId, timeWindow, sort])

  async function fetchChannel() {
    setLoading(true)
    try {
      const params = new URLSearchParams({ window: timeWindow, sort })
      const res = await fetch(`/api/channels/${channelId}/videos?${params}`)
      if (!res.ok) throw new Error('Not found')
      setData(await res.json())
    } catch (e) {
      console.error('Failed to fetch channel:', e)
      setData(null)
    }
    setLoading(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
        Loading...
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
        Channel not found.
      </div>
    )
  }

  const ch = data.channel

  return (
    <div className="px-6 py-4">
      {/* Back button */}
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-[#777] hover:text-white mb-4 transition-colors"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back to channels
      </button>

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

      {/* Sentinel — when this scrolls off-screen, TopBar takes over */}
      <div ref={sentinelRef} />

      {/* Controls (page-level) */}
      <div className="mb-4">
        <TimeSortControls
          window={timeWindow}
          onWindowChange={onTimeWindowChange}
          sort={sort}
          onSortChange={onSortChange}
        />
      </div>

      {/* Video grid */}
      {data.videos.length === 0 ? (
        <div className="flex items-center justify-center h-32 text-[#aaaaaa] text-sm">
          No videos in this time range.
        </div>
      ) : (
        <VideoRow group={{ name: ch.title, icon: '', sort_order: 0, videos: data.videos }} onChannelClick={(id) => window.open(`https://www.youtube.com/channel/${id}`, '_blank')} />
      )}
    </div>
  )
}