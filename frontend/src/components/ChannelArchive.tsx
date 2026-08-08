import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../lib/api'

export type ArchiveStatus = {
  held: number
  lifetime: number | null
  reachable: number | null
  capped_by_api: boolean
  remaining: number | null
  oldest_held: string | null
  exhausted: boolean
  started: boolean
  filling: boolean
}

const POLL_MS = 2500

function shortDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

/**
 * How much of a channel's back catalogue we hold, and the button that fetches
 * the rest.
 *
 * The counts come from two places that can disagree: `held` is ours, `lifetime`
 * is YouTube's. When a channel has more videos than the uploads playlist will
 * page through, `reachable` is the smaller honest number — promising "all
 * 40,097" would leave the bar stuck at half forever.
 */
export function useArchiveStatus(channelId: string) {
  const [status, setStatus] = useState<ArchiveStatus | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const activeRef = useRef<string>(channelId)

  const load = useCallback(async (): Promise<ArchiveStatus | null> => {
    try {
      const res = await apiFetch(`/api/channels/${channelId}/archive`, { quiet: true })
      if (!res.ok || activeRef.current !== channelId) return null
      const s: ArchiveStatus = await res.json()
      setStatus(s)
      return s
    } catch {
      return null
    }
  }, [channelId])

  // Poll only while a fill is actually running — the rest of the time this is
  // a static readout and there is nothing to watch.
  const poll = useCallback(async () => {
    const s = await load()
    if (activeRef.current !== channelId) return
    if (s?.filling) timerRef.current = window.setTimeout(poll, POLL_MS)
  }, [channelId, load])

  useEffect(() => {
    activeRef.current = channelId
    setStatus(null)
    void poll()
    return () => {
      activeRef.current = ''
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [channelId, poll])

  const start = useCallback(async () => {
    setStatus((s) => (s ? { ...s, filling: true } : s))
    try {
      await apiFetch(`/api/channels/${channelId}/archive`, { method: 'POST', quiet: true })
    } catch { /* the poll below reports the real state either way */ }
    void poll()
  }, [channelId, poll])

  return { status, start, reload: load }
}

export default function ChannelArchive({
  status, onStart,
}: { status: ArchiveStatus | null; onStart: () => void }) {
  if (!status) return null

  const { held, reachable, remaining, oldest_held, exhausted, capped_by_api, filling } = status
  const pct = reachable ? Math.min(100, Math.round((held / reachable) * 100)) : 0

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      <span className="text-[#777]">
        {exhausted ? (
          <>Complete — all {held.toLocaleString()} videos</>
        ) : reachable ? (
          <>{held.toLocaleString()} of {reachable.toLocaleString()} videos</>
        ) : (
          <>{held.toLocaleString()} videos</>
        )}
        {oldest_held && <span className="text-[#555]"> · back to {shortDate(oldest_held)}</span>}
      </span>

      {!exhausted && reachable != null && (
        <span className="h-1 w-24 overflow-hidden rounded-full bg-[#272727]" aria-hidden>
          <span className="block h-full bg-[#777]" style={{ width: `${pct}%` }} />
        </span>
      )}

      {filling ? (
        <span className="text-[#aaa]">Fetching…</span>
      ) : !exhausted && (remaining == null || remaining > 0) ? (
        <button
          onClick={onStart}
          className="cursor-pointer rounded-full border border-[#3f3f3f] px-2.5 py-0.5 text-[#aaa] transition-colors hover:border-[#666] hover:text-white"
        >
          Fetch the rest{remaining ? ` (${remaining.toLocaleString()})` : ''}
        </button>
      ) : null}

      {/* Said plainly rather than shown as a bar that can never fill: YouTube's
          uploads playlist stops at 20,000 however many videos exist. */}
      {capped_by_api && (
        <span className="text-[#555]">YouTube only serves the newest 20,000</span>
      )}
    </div>
  )
}
