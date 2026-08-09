import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import AddChannelDialog from './AddChannelDialog'

type ChannelInfo = {
  youtube_id: string
  title: string
  description: string
  thumbnail_url: string
  subscriber_count: number
  tags: string[]
  // "subscription" (came from YouTube) or "manual" (added by hand). Only the
  // hand-added ones can be removed here — see remove_channel on the server.
  source: string
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

const TrashIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0v12a1 1 0 001 1h6a1 1 0 001-1V7" />
  </svg>
)

export default function ChannelsPage({ selectedTags, onSelectChannel, sort, hiddenChannels, onToggleHidden }: Props) {
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  // The hand-added channel whose delete button has been pressed once. Removing
  // a channel deletes its videos, so it asks — in place, on the card, because
  // that's where you can still see which channel you're about to lose.
  const [confirming, setConfirming] = useState<string | null>(null)

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

  async function removeChannel(channelId: string) {
    setConfirming(null)
    setChannels((prev) => prev.filter((c) => c.youtube_id !== channelId))
    try { await apiFetch(`/api/channels/${channelId}`, { method: 'DELETE' }) }
    catch { fetchChannels() }
  }

  // The dialog and the header button belong to the page rather than to the
  // list, so they survive the loading and empty states below — an empty
  // Channels page is exactly where "add one" needs to be reachable.
  const dialog = adding && (
    <AddChannelDialog
      onClose={() => setAdding(false)}
      onAdded={(id) => { setAdding(false); fetchChannels(); onSelectChannel(id) }}
    />
  )

  const addButton = (
    <button
      onClick={() => setAdding(true)}
      className="flex items-center gap-1.5 rounded-full bg-[#272727] px-3 py-1.5 text-sm text-white transition-colors hover:bg-[#3a3a3a]"
    >
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m-7-7h14" />
      </svg>
      Add channel
    </button>
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
        Loading channels...
      </div>
    )
  }

  if (channels.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-[#aaaaaa]">
        <p className="text-sm">
          {selectedTags.length > 0 ? 'No channels match the selected tags.' : 'No channels yet.'}
        </p>
        {addButton}
        {dialog}
      </div>
    )
  }

  const hiddenCount = channels.reduce((n, ch) => n + (hiddenChannels.has(ch.youtube_id) ? 1 : 0), 0)

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-[#777]">
          {channels.length} channels
          {hiddenCount > 0 && <span className="text-[#666]"> · {hiddenCount} hidden from home</span>}
        </p>
        {addButton}
      </div>
      {dialog}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {channels.map((ch) => {
          const isHidden = hiddenChannels.has(ch.youtube_id)
          return (
          <div
            key={ch.youtube_id}
            onClick={() => onSelectChannel(ch.youtube_id)}
            className={`group relative bg-[#1a1a1a] rounded-xl p-4 border transition-colors cursor-pointer ${isHidden ? 'border-[#333] opacity-60 hover:opacity-100' : 'border-[#272727] hover:border-[#444]'}`}
          >
            {/* Remove — only for the hand-added ones. A subscribed channel is
                here because YouTube says you're subscribed, so deleting it
                would last until the next resync put it back. */}
            {ch.source === 'manual' && (
              <button
                onClick={(e) => { e.stopPropagation(); setConfirming(confirming === ch.youtube_id ? null : ch.youtube_id) }}
                title="Remove channel"
                aria-label="Remove channel"
                className="absolute top-2 right-10 z-10 p-1.5 rounded-full text-[#aaa] opacity-0 transition-colors hover:bg-white/10 hover:text-white group-hover:opacity-100"
              >
                <TrashIcon />
              </button>
            )}
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

            {confirming === ch.youtube_id && (
              <div
                className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-[#2a1a1a] px-3 py-2 ring-1 ring-red-500/30"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-xs text-[#ccc]">Remove this channel and its videos?</span>
                <div className="flex flex-shrink-0 gap-1">
                  <button
                    onClick={() => setConfirming(null)}
                    className="rounded-full px-2 py-1 text-xs text-[#aaa] hover:bg-white/10 hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => removeChannel(ch.youtube_id)}
                    className="rounded-full bg-red-500/20 px-2 py-1 text-xs text-red-300 hover:bg-red-500/30"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}
          </div>
          )
        })}
      </div>
    </div>
  )
}
