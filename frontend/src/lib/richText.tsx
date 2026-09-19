/**
 * Free-text from YouTube — descriptions, comments — rendered with its links and
 * its timestamps live.
 *
 * The timestamps are the reason this is shared rather than private to the watch
 * page. "Skip to 12:40" is written by hand in a comment thousands of times a
 * day on the assumption that whoever reads it is sitting in front of the player,
 * and here they are: one `onSeek` and the sentence does what it says.
 */
import type { ReactNode } from 'react'
import { getLang, locale } from './i18n'

// H:MM:SS, MM:SS, or M:SS.
export const TIMESTAMP_RE = /(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)/g

/** Split a plain (non-URL) chunk, turning timestamps into seek buttons. */
export function withTimestamps(text: string, keyBase: string, onSeek: (s: number) => void): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  TIMESTAMP_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TIMESTAMP_RE.exec(text)) !== null) {
    const [full, hh, mm, ss] = m
    const total = (hh ? Number(hh) * 3600 : 0) + Number(mm) * 60 + Number(ss)
    if (m.index > last) nodes.push(text.slice(last, m.index))
    nodes.push(
      <button
        key={`${keyBase}-${m.index}`}
        onClick={() => onSeek(total)}
        className="text-blue-400 hover:underline"
      >
        {full}
      </button>
    )
    last = m.index + full.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** Render text with URLs as links and timestamps as seek buttons. */
export function linkify(text: string, onSeek: (s: number) => void) {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noreferrer noopener"
        className="text-blue-400 hover:underline [overflow-wrap:anywhere]"
      >
        {part}
      </a>
    ) : (
      <span key={i}>{withTimestamps(part, String(i), onSeek)}</span>
    )
  )
}

/**
 * Big numbers the way YouTube writes them: 1.2M, 4.5K, 831 — or, in Chinese,
 * in 萬 and 億 (35.6萬, 1.2億), which is how YouTube writes them there. The
 * other languages get their own short forms from Intl (35.6万, 35.6만, 356K…).
 */
export function formatCount(n: number): string {
  const lang = getLang()
  if (lang === 'zh-Hant') {
    if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}億`
    if (n >= 10_000) return `${(n / 10_000).toFixed(1)}萬`
    return String(n)
  }
  if (lang !== 'en') {
    return new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n)
  }
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
