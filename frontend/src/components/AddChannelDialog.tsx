import { useEffect, useRef, useState } from 'react'
import { addChannel, lookupChannel } from '../lib/channels'
import type { ChannelLookup } from '../lib/channels'

type Props = {
  onClose: () => void
  // The channel that was added, so the page behind can refresh and open it.
  onAdded: (channelId: string) => void
}

function formatSubs(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

/**
 * Add a channel the app doesn't hold, from a link, an @handle or a bare id.
 *
 * Two steps rather than one: look up, LOOK at what came back, then add. A
 * handle is easy to mistype into a different real channel, and an avatar and a
 * subscriber count answer "is this the one I meant?" before anything is written.
 */
export default function AddChannelDialog({ onClose, onAdded }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState<ChannelLookup | null>(null)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const look = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError('')
    setFound(null)
    const info = await lookupChannel(text.trim())
    if (!info) setError("Couldn't find a channel for that. A link, an @handle or the channel id all work.")
    setFound(info)
    setBusy(false)
  }

  const add = async () => {
    if (!found || busy) return
    setBusy(true)
    const res = await addChannel(text.trim())
    setBusy(false)
    if (!res) { setError("Couldn't add that channel."); return }
    onAdded(res.youtube_id)
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 p-4 pt-24"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-[#212121] p-5 shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-medium text-white">Add a channel</h2>
        <p className="mt-1 text-xs text-[#888]">
          Any channel, subscribed or not. Its videos join the feed and update with everything else.
        </p>

        <div className="mt-3 flex gap-2">
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => { setText(e.target.value); setFound(null); setError('') }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); found ? add() : look() } }}
            placeholder="https://www.youtube.com/@someone"
            className="min-w-0 flex-1 rounded-lg bg-[#121212] px-3 py-2 text-sm text-white placeholder-[#555] outline-none ring-1 ring-[#303030] focus:ring-[#3ea6ff]"
          />
          <button
            onClick={look}
            disabled={!text.trim() || busy}
            className="rounded-full bg-[#272727] px-4 py-1.5 text-sm text-white transition-colors hover:bg-[#3a3a3a] disabled:opacity-40"
          >
            Look up
          </button>
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        {found && (
          <div className="mt-4 flex items-start gap-3 rounded-lg bg-[#181818] p-3 ring-1 ring-[#303030]">
            <img
              src={found.thumbnail_url}
              alt={found.title}
              className="h-12 w-12 flex-shrink-0 rounded-full bg-[#333] object-cover"
            />
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-medium text-white">{found.title}</h3>
              {found.subscriber_count > 0 && (
                <p className="text-xs text-[#777]">{formatSubs(found.subscriber_count)} subscribers</p>
              )}
              {found.description && (
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[#555]">{found.description}</p>
              )}
            </div>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-full px-4 py-1.5 text-sm text-[#aaa] transition-colors hover:bg-white/10 hover:text-white"
          >
            Cancel
          </button>
          {found && (found.known ? (
            <button
              onClick={() => onAdded(found.youtube_id)}
              className="rounded-full bg-[#272727] px-4 py-1.5 text-sm text-white transition-colors hover:bg-[#3a3a3a]"
            >
              Already added — open it
            </button>
          ) : (
            <button
              onClick={add}
              disabled={busy}
              className="rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black transition-colors hover:bg-[#ddd] disabled:opacity-40"
            >
              {busy ? 'Adding…' : 'Add channel'}
            </button>
          ))}
        </div>

        {busy && found && (
          // The add awaits a first scan of the channel's uploads, so the page
          // you land on has videos on it rather than an empty grid.
          <p className="mt-2 text-right text-xs text-[#666]">Fetching its recent videos…</p>
        )}
      </div>
    </div>
  )
}
