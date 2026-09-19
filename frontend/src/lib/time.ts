import { stampMs } from './timeWindow'
import { t } from './i18n'

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
  const mins = Math.floor((Date.now() - then) / 60_000)
  if (mins < 1) return t('Just now')
  if (mins < 60) return t('{n}m ago', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('{n}h ago', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('{n}d ago', { n: days })
  const months = Math.floor(days / 30)
  if (months < 12) return t('{n}mo ago', { n: months })
  return t('{n}y ago', { n: Math.floor(months / 12) })
}
