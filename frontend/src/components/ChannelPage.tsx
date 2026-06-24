import { useState, useEffect } from 'react'
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
}

const WINDOWS = [
  { value: '1d', label: '1d' },
  { value: '3d', label: '3d' },
  { value: '1w', label: '1w' },
  { value: '2w', label: '2w' },
  { value: '1m', label: '1m' },
  { value: '3m', label: '3m' },
  { value: '6m', label: '6m' },
  { value: '1y', label: '1y' },
] as const

const SORT_OPTIONS = [
  { value: 'score', label: 'Score' },
  { value: 'views', label: 'Views' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
]

function formatSubs(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

export default function ChannelPage({ channelId, onBack }: Props) {
  const [data, setData] = useState<ChannelResponse | null>(null)
  const [window, setWindow] = useState('1w')
  const [sort, setSort] = useState('score')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchChannel()
  }, [channelId, window, sort])

  async function fetchChannel() {
    setLoading(true)
    try {
      const params = new URLSearchParams({ window, sort })
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

      {/* Controls */}
      <div className="flex items-center gap-4 mb-4">
        {/* Time filter */}
        <div className="flex items-center gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              onClick={() => setWindow(w.value)}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                window === w.value
                  ? 'bg-white text-black font-medium'
                  : 'bg-[#272727] text-white hover:bg-[#3a3a3a]'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex gap-1 bg-[#1a1a1a] rounded-lg p-0.5">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSort(opt.value)}
              className={`px-2 py-1 text-[11px] rounded-md transition-colors ${
                sort === opt.value
                  ? 'bg-[#272727] text-white font-medium'
                  : 'text-[#555] hover:text-white'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <span className="text-xs text-[#555] ml-auto">{data.total} videos</span>
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