/**
 * The speeds the player offers — the `playback_speeds` setting.
 *
 * One list does two jobs: it's the menu in the control bar, and it's what the
 * slower/faster keys step through. Keeping them the same list is the point of
 * making it a setting at all — someone who wants 0.1 steps wants them in both
 * places, and a menu that doesn't contain the speed the keyboard just set would
 * be lying about where you are.
 *
 * Installed at startup by DefaultsLoader and again when Settings saves, like
 * the caption defaults; stored per person on the server, so it follows you
 * between browsers.
 */

/** YouTube's own list, which is a good answer for most people. */
export const DEFAULT_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

// What a stored list may contain. The floor is a speed you can still follow;
// the ceiling is where the audio stops being speech. The count is a menu that
// still fits over the video — and past a dozen rates the keyboard is the only
// sane way to reach one anyway.
export const MIN_SPEED = 0.1
export const MAX_SPEED = 5
export const MAX_SPEEDS = 12

let current = DEFAULT_SPEEDS

/** The speeds in force. Always includes 1 (see `parseSpeeds`). */
export function playbackSpeeds(): number[] { return current }

/** Install the stored setting. A list that doesn't parse leaves the default
 *  standing rather than emptying the menu. */
export function setSpeedDefaults(value: unknown) {
  current = cleanSpeeds(value) ?? DEFAULT_SPEEDS
}

/** A stored value as a usable list, or null if there's nothing usable in it.
 *
 *  Normal speed is forced in: it's where every video starts and the one rate
 *  you must be able to get back to, so a list without it would be a menu with
 *  no way home. */
export function cleanSpeeds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const out = new Set<number>()
  for (const v of value) {
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n) || n < MIN_SPEED || n > MAX_SPEED) continue
    out.add(round(n))
  }
  if (out.size === 0) return null
  out.add(1)
  return [...out].sort((a, b) => a - b).slice(0, MAX_SPEEDS)
}

/** Two decimals, so 1.1 + typing doesn't leave 1.1000000000000001 in a menu. */
function round(n: number): number { return Math.round(n * 100) / 100 }

/** What the settings field accepts: speeds separated by commas or spaces, with
 *  or without a trailing `x`. Returns null when nothing in the text is a usable
 *  speed, so the editor can say so instead of saving an empty menu. */
export function parseSpeeds(text: string): number[] | null {
  const parts = text.split(/[,\s]+/).map((s) => s.trim().replace(/[x×]$/i, '')).filter(Boolean)
  if (parts.some((p) => !Number.isFinite(Number(p)))) return null
  return cleanSpeeds(parts.map(Number))
}

/** The list as the settings field shows it. */
export function formatSpeeds(speeds: number[]): string {
  return speeds.join(', ')
}

/** The next speed up (`dir` 1) or down (-1) the list, from wherever we are now.
 *
 *  "Wherever" can be a rate the list doesn't hold — a <video> takes any number
 *  at all, and the list can change under a video that's already playing — so
 *  this steps from the NEAREST listed speed rather than from an index, and
 *  stops at both ends instead of wrapping: a keypress that jumps from 2× back
 *  to 0.25× is never what was meant. */
export function nextSpeed(rate: number, dir: 1 | -1, speeds: number[] = current): number {
  if (speeds.length === 0) return rate
  const near = speeds.reduce((best, r) => (Math.abs(r - rate) < Math.abs(best - rate) ? r : best))
  const i = speeds.indexOf(near)
  return speeds[Math.max(0, Math.min(speeds.length - 1, i + dir))]
}
