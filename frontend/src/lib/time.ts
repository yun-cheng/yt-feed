import { stampMs } from './timeWindow'

/** A player clock: m:ss, or h:mm:ss once there's an hour to show. */
export function formatTime(s: number): string {
  const t = Math.max(0, Math.floor(s))
  const mm = Math.floor(t / 60) % 60
  const ss = t % 60
  const hh = Math.floor(t / 3600)
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`
}

/** How long ago a server timestamp was, the way cards and the watch page say it. */
export function timeAgo(iso: string): string {
  const then = stampMs(iso)
  if (then === null) return ''
  const hours = Math.floor((Date.now() - then) / 3_600_000)
  if (hours < 1) return 'Just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}
