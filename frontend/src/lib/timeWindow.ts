/**
 * The time filter's model.
 *
 * A window is a PAIR of ticks on a fixed ladder of day boundaries — not one of
 * eight presets. The ladder is the same one the ranking engine uses, so nothing
 * about what the labels mean changes:
 *
 *   days:    0     1     3     7    14    30    90   180   365    ∞
 *   label:  now   1d    3d    1w    2w    1m    3m    6m    1y   all
 *   index:   0     1     2     3     4     5     6     7     8     9
 *
 * A pair of ticks reaches all 45 ranges the ladder can express. The preset row
 * this replaced reached 15 of them: a window either ran from 0 or was exactly
 * one notch wide, which is now just the question "is lo sitting at 0?".
 *
 * The last rung is unbounded. Everything the range arithmetic does is by INDEX
 * (`clampRange` never looks at a day count), so an infinite rung is a change to
 * the ladder rather than to the model — only the four functions below that
 * translate an index into days have to know about it.
 */

export const TICK_DAYS = [0, 1, 3, 7, 14, 30, 90, 180, 365, Infinity]
export const TICK_LABELS = ['now', '1d', '3d', '1w', '2w', '1m', '3m', '6m', '1y', 'all']
export const MAX_TICK = TICK_DAYS.length - 1

/** How the unbounded edge spells itself on the wire. */
export const ALL_TOKEN = 'all'

const DAY_MS = 86_400_000

/** Indices into the ladder. `lo` is the recent edge, `hi` the older one. */
export type TimeRange = { lo: number; hi: number }

/** Past 3 days — what the feed opens on. */
export const DEFAULT_RANGE: TimeRange = { lo: 0, hi: 2 }

/** Everything, back to whenever — what the library pages open on. */
export const ALL_RANGE: TimeRange = { lo: 0, hi: MAX_TICK }

/**
 * Force a pair onto the ladder: whole numbers, in bounds, in order, and at
 * least one bucket wide. A zero-width range would select nothing at all, so
 * the slider is given `minStepsBetweenThumbs={1}` and this backs it up for
 * every other way a range can arrive (URL, tick clicks).
 */
export function clampRange(r: TimeRange): TimeRange {
  let lo = Math.round(r.lo)
  let hi = Math.round(r.hi)
  if (lo > hi) [lo, hi] = [hi, lo]
  hi = Math.min(MAX_TICK, Math.max(1, hi))
  lo = Math.min(hi - 1, Math.max(0, lo))
  return { lo, hi }
}

/**
 * The ladder index closest to a raw day count, so a hand-edited URL still
 * works. Never returns the unbounded rung: no finite number of days is nearer
 * to infinity than to 1y, so `?age=0-99999` still means "the past year" rather
 * than quietly becoming "everything".
 */
export function nearestTick(days: number): number {
  let best = 0
  for (let i = 1; i < TICK_DAYS.length; i++) {
    if (Math.abs(TICK_DAYS[i] - days) < Math.abs(TICK_DAYS[best] - days)) best = i
  }
  return best
}

/** The wire format: day counts, not indices, so `?age=3-14` reads as itself. */
export function formatAge(r: TimeRange): string {
  const older = TICK_DAYS[r.hi]
  return `${TICK_DAYS[r.lo]}-${Number.isFinite(older) ? older : ALL_TOKEN}`
}

export function parseAge(s: string | null | undefined): TimeRange | null {
  const m = new RegExp(`^(\\d+)-(\\d+|${ALL_TOKEN})$`).exec((s ?? '').trim())
  if (!m) return null
  // The token bypasses nearestTick: |∞ − ∞| is NaN, which would compare false
  // against every rung and silently land on index 0.
  const hi = m[2] === ALL_TOKEN ? MAX_TICK : nearestTick(+m[2])
  return clampRange({ lo: nearestTick(+m[1]), hi })
}

export function rangeLabel(r: TimeRange): string {
  const unbounded = !Number.isFinite(TICK_DAYS[r.hi])
  if (r.lo === 0) return unbounded ? 'All time' : `Past ${TICK_LABELS[r.hi]}`
  if (unbounded) return `Older than ${TICK_LABELS[r.lo]}`
  return `${TICK_LABELS[r.lo]}–${TICK_LABELS[r.hi]} ago`
}

/** Epoch-ms bounds, for the lists that are filtered in the browser. */
export function rangeBounds(r: TimeRange, now: number): { from: number; to: number } {
  // An unbounded older edge yields -Infinity, which every `t >= from` accepts.
  return { from: now - TICK_DAYS[r.hi] * DAY_MS, to: now - TICK_DAYS[r.lo] * DAY_MS }
}

const ZONED = /(Z|[+-]\d{2}:?\d{2})$/

/**
 * Epoch ms for a timestamp the API wrote — or null if there isn't a usable one.
 *
 * The backend stamps rows with `datetime.utcnow().isoformat()`, which carries no
 * zone, and `new Date` reads a zoneless *datetime* as LOCAL time. Left alone,
 * every row would sit hours away from where it belongs — enough to push
 * something you saved this morning out of a "past 1d" window. A bare date has
 * the opposite rule (already UTC by spec), so only the `T` form is corrected.
 */
export function stampMs(s: string | null | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s.includes('T') && !ZONED.test(s) ? `${s}Z` : s)
  return Number.isNaN(t) ? null : t
}

/**
 * Is a moment inside the window?
 *
 * A row with no timestamp is **kept**, on every window including this one.
 * Missing means the field predates the row, not that the row is infinitely old,
 * and dropping it would make it unreachable even at "All time".
 */
export function inWindow(stamp: string | null | undefined, r: TimeRange, now: number): boolean {
  const t = stampMs(stamp)
  if (t === null) return true
  const { from, to } = rangeBounds(r, now)
  return t >= from && t < to
}

export function sameRange(a: TimeRange, b: TimeRange): boolean {
  return a.lo === b.lo && a.hi === b.hi
}
