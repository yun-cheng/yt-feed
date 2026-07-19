import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'

type ChannelInfo = {
  youtube_id: string
  title: string
  description: string
  thumbnail_url: string
  subscriber_count: number
  tags: string[]
  last_video_fetched: string | null
}

type Props = {
  selectedTags: string[]
  onSelectChannel: (channelId: string) => void
  sort: string
  onSortChange: (s: string) => void
  hiddenChannels: Set<string>
  onToggleHidden: (channelId: string) => void
}

function formatSubs(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

const EyeIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
  </svg>
)

const EyeOffIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.542-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.542 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
  </svg>
)

export default function ChannelsPage({ selectedTags, onSelectChannel, sort, hiddenChannels, onToggleHidden }: Props) {
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchChannels()
  }, [selectedTags, sort])

  async function fetchChannels() {
    setLoading(true)
    try {
      const params = new URLSearchParams({ sort })
      if (selectedTags.length > 0) params.set('tags', selectedTags.join(','))
      const res = await apiFetch(`/api/channels?${params}`)
      setChannels(await res.json())
    } catch (e) {
      console.error('Failed to fetch channels:', e)
    }
    setLoading(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
        Loading channels...
      </div>
    )
  }

  if (channels.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
        {selectedTags.length > 0 ? 'No channels match the selected tags.' : 'No channels found.'}
      </div>
    )
  }

  const hiddenCount = channels.reduce((n, ch) => n + (hiddenChannels.has(ch.youtube_id) ? 1 : 0), 0)

  return (
    <div className="p-6">
      <p className="text-sm text-[#777] mb-4">
        {channels.length} channels
        {hiddenCount > 0 && <span className="text-[#666]"> · {hiddenCount} hidden from home</span>}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {channels.map((ch) => {
          const isHidden = hiddenChannels.has(ch.youtube_id)
          return (
          <div
            key={ch.youtube_id}
            onClick={() => onSelectChannel(ch.youtube_id)}
            className={`group relative bg-[#1a1a1a] rounded-xl p-4 border transition-colors cursor-pointer ${isHidden ? 'border-[#333] opacity-60 hover:opacity-100' : 'border-[#272727] hover:border-[#444]'}`}
          >
            {/* Hide/show toggle */}
            <button
              onClick={(e) => { e.stopPropagation(); onToggleHidden(ch.youtube_id) }}
              title={isHidden ? 'Show on home' : 'Hide from home'}
              aria-label={isHidden ? 'Show on home' : 'Hide from home'}
              className={`absolute top-2 right-2 z-10 p-1.5 rounded-full text-[#aaa] hover:bg-white/10 hover:text-white transition-colors ${isHidden ? '' : 'opacity-0 group-hover:opacity-100'}`}
            >
              {isHidden ? <EyeOffIcon /> : <EyeIcon />}
            </button>
            {isHidden && (
              <span className="absolute top-2.5 left-4 text-[10px] font-medium text-amber-400/80 bg-amber-400/10 px-1.5 py-0.5 rounded">
                Hidden from home
              </span>
            )}
            <div className={`flex items-start gap-3 ${isHidden ? 'mt-5' : ''}`}>
              <img
                src={ch.thumbnail_url}
                alt={ch.title}
                className="w-14 h-14 rounded-full object-cover flex-shrink-0 bg-[#333]"
                loading="lazy"
              />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium text-white truncate group-hover:text-blue-400 transition-colors">
                  {ch.title}
                </h3>
                {ch.subscriber_count > 0 && (
                  <p className="text-xs text-[#777] mt-0.5">
                    {formatSubs(ch.subscriber_count)} subscribers
                  </p>
                )}
              </div>
            </div>

            {ch.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3">
                {ch.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-0.5 text-[10px] bg-[#272727] text-[#999] rounded-full"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {ch.description && (
              <p className="text-xs text-[#555] mt-2 line-clamp-2 leading-relaxed">
                {ch.description}
              </p>
            )}
          </div>
          )
        })}
      </div>
    </div>
  )
}
