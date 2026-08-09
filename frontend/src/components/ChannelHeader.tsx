import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

type Channel = {
  youtube_id: string
  title: string
  description: string
  thumbnail_url: string
  subscriber_count: number
}

type Props = {
  channel: Channel
  // Between the subscriber count and the description: the tag editor on a
  // channel we hold, nothing on one we don't.
  aside?: ReactNode
  // Below the description: the archive readout, which only a held channel has.
  children?: ReactNode
  // In the action row, before the Open-on-YouTube link — "Add to your feed".
  actions?: ReactNode
}

function formatSubs(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

/**
 * The block at the top of a channel page: avatar, name, subscriber count,
 * description, and the link out to YouTube.
 *
 * Shared by the two pages that draw one — a channel we hold, and a channel we
 * don't but could add. Those differ only in what hangs off the header (tags and
 * the archive readout on one, an Add button on the other), which is what the
 * three slots are for. Written as a component the second time round: the first
 * version of the add-a-channel page copied this markup, and a copy is how the
 * two quietly drift apart.
 *
 * The description's expand/collapse lives here rather than in either page,
 * because the measurement it depends on is a fact about this element.
 */
export default function ChannelHeader({ channel, aside, children, actions }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const descRef = useRef<HTMLParagraphElement>(null)

  // Only offer the toggle when the clamped text is actually clipped. Measured
  // off the (initially clamped) element, so it must run before expansion.
  useEffect(() => {
    const el = descRef.current
    if (!el) { setOverflows(false); return }
    setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [channel.description])

  return (
    <div className="flex items-start gap-4 mb-6 pb-6 border-b border-[#272727]">
      <img
        src={channel.thumbnail_url}
        alt={channel.title}
        className="w-20 h-20 rounded-full object-cover bg-[#333] flex-shrink-0"
      />
      <div className="min-w-0">
        <h2 className="text-xl font-bold text-white">{channel.title}</h2>
        {/* Hidden at zero rather than shown as "0 subscribers", which is a
            channel that hides its count, not one nobody watches. */}
        {channel.subscriber_count > 0 && (
          <p className="text-sm text-[#777] mt-1">
            {formatSubs(channel.subscriber_count)} subscribers
          </p>
        )}
        {aside}
        {channel.description && (
          <div className="max-w-xl">
            <p
              ref={descRef}
              className={`text-xs text-[#555] mt-2 leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] ${expanded ? '' : 'line-clamp-2'}`}
            >
              {channel.description}
            </p>
            {(overflows || expanded) && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="mt-1 text-xs font-medium text-[#777] hover:text-[#aaa]"
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        )}
        {children}
        {/* The link keeps its own line directly under the description, where a
            held channel has always had it; anything the page adds goes below,
            so the two pages read the same way down to the point they differ. */}
        <a
          href={`https://www.youtube.com/channel/${channel.youtube_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block mt-2 text-xs text-blue-400 hover:text-blue-300"
        >
          Open on YouTube →
        </a>
        {actions && <div className="mt-3 flex items-center gap-3">{actions}</div>}
      </div>
    </div>
  )
}
