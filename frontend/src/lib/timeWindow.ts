/**
 * The time filter's model.
 *
 * A window is a PAIR of ticks on a fixed ladder of day boundaries — not one of
 * eight presets. The ladder is the same one the ranking engine already uses
 * (backend `WINDOW_RANGES`), so nothing about what the labels mean changes:
 *
 *   days:    0     1     3     7    14    30    90   180   365
 *   label:  now   1d    3d    1w    2w    1m    3m    6m    1y
 *   index:   0     1     2     3     4     5     6     7     8
 *
 * The old (window, time_mode) pair could only reach ranges anchored at 0
 * ("wide") or exactly one notch wide ("narrow") — 15 of the 36 possible pairs.
 * A range of ticks reaches all of them, and the wide/narrow distinction becomes
 * the question "is lo sitting at 0?".
 */

export const TICK_DAYS = [0, 1, 3, 7, 14, 30, 90, 180, 365]
export const TICK_LABELS = ['now', '1d', '3d', '1w', '2w', '1m', '3m', '6m', '1y']
export const MAX_TICK = TICK_DAYS.length - 1

const DAY_MS = 86_400_000

/** Indices into the ladder. `lo` is the recent edge, `hi` the older one. */
export type TimeRange = { lo: number; hi: number }

/** Past 3 days — what the feed opened on before, spelled in the new model. */
export const DEFAULT_RANGE: TimeRange = { lo: 0, hi: 2 }

/**
 * Force a pair onto the ladder: whole numbers, in bounds, in order, and at
 * least one bucket wide. A zero-width range would select nothing at all, so
 * the slider is given `minStepsBetweenThumbs={1}` and this backs it up for
 * every other way a range can arrive (URL, legacy params, tick clicks).
 */
export function clampRange(r: TimeRange): TimeRange {
  let lo = Math.round(r.lo)
  let hi = Math.round(r.hi)
  if (lo > hi) [lo, hi] = [hi, lo]
  hi = Math.min(MAX_TICK, Math.max(1, hi))
  lo = Math.min(hi - 1, Math.max(0, lo))
  return { lo, hi }
}

/** The ladder index closest to a raw day count, so a hand-edited URL still works. */
export function nearestTick(days: number): number {
  let best = 0
  for (let i = 1; i < TICK_DAYS.length; i++) {
    if (Math.abs(TICK_DAYS[i] - days) < Math.abs(TICK_DAYS[best] - days)) best = i
  }
  return best
}

/** The wire format: day counts, not indices, so `?age=3-14` reads as itself. */
export function formatAge(r: TimeRange): string {
  return `${TICK_DAYS[r.lo]}-${TICK_DAYS[r.hi]}`
}

export function parseAge(s: string | null | undefined): TimeRange | null {
  const m = /^(\d+)-(\d+)$/.exec((s ?? '').trim())
  if (!m) return null
  return clampRange({ lo: nearestTick(+m[1]), hi: nearestTick(+m[2]) })
}

/**
 * Read a pre-slider URL. Old bookmarks keep resolving to the range they always
 * meant: wide ran from 0, narrow from the bucket's own lower edge.
 */
export function rangeFromLegacy(window: string | null, timeMode: string | null): TimeRange | null {
  const hi = TICK_LABELS.indexOf(window ?? '')
  if (hi < 1) return null
  return clampRange({ lo: timeMode === 'narrow' ? hi - 1 : 0, hi })
}

export function rangeLabel(r: TimeRange): string {
  return r.lo === 0 ? `Past ${TICK_LABELS[r.hi]}` : `${TICK_LABELS[r.lo]}–${TICK_LABELS[r.hi]} ago`
}

/** Epoch-ms bounds, for the lists that are filtered in the browser. */
export function rangeBounds(r: TimeRange, now: number): { from: number; to: number } {
  return { from: now - TICK_DAYS[r.hi] * DAY_MS, to: now - TICK_DAYS[r.lo] * DAY_MS }
}

export function sameRange(a: TimeRange, b: TimeRange): boolean {
  return a.lo === b.lo && a.hi === b.hi
}
