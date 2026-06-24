import { useState, useEffect } from 'react'

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
}

function formatSubs(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

export default function ChannelsPage({ selectedTags, onSelectChannel, sort }: Props) {
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
      const res = await fetch(`/api/channels?${params}`)
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

  return (
    <div className="p-6">
      <p className="text-sm text-[#777] mb-4">{channels.length} channels</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {channels.map((ch) => (
          <div
            key={ch.youtube_id}
            onClick={() => onSelectChannel(ch.youtube_id)}
            className="group bg-[#1a1a1a] rounded-xl p-4 border border-[#272727] hover:border-[#444] transition-colors cursor-pointer"
          >
            <div className="flex items-start gap-3">
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
        ))}
      </div>
    </div>
  )
}
