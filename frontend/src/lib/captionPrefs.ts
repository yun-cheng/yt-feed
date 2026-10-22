/**
 * How captions look — on or off, word by word or whole sentences, where, and
 * how big. Kept in localStorage so it carries across videos and sessions: the
 * watch overlay remounts per video, re-reading these on mount.
 */

// Which LANGUAGE they're in is not here: every video opens on your default
// caption languages (the caption_lang settings, lib/captionDefaults), and a
// language picked on a video lasts for that video.
export const CAPTION_PREFS_KEY = 'ytfeed:caption-prefs'
// How the caption block is drawn, as opposed to which track it draws. Size is a
// multiplier on YouTube's own 2.5%-of-player-width, so 1 is "the same size
// YouTube would have drawn it". YouTube's own ladder jumps 100 → 150 → 200; on a
// player this wide those are different decisions rather than adjustments, so this
// steps by 10% and lets you stop where it actually looks right.
export const CAPTION_SIZE_MIN = 0.5
export const CAPTION_SIZE_MAX = 3
export const CAPTION_SIZE_STEP = 0.1
// Every size passes through here, so a tenth stays a tenth instead of drifting
// into 1.2000000000000002 and printing as 120.00000000000001%.
export const roundSize = (n: number) =>
  Math.round(Math.min(CAPTION_SIZE_MAX, Math.max(CAPTION_SIZE_MIN, n)) * 10) / 10
// `pos` is the main track's edge and `pos2` the second track's. Apart, so a
// translation can sit at the top while the spoken line keeps the bottom; at the
// same edge they stack as one block, main first.
export const CAPTION_DISPLAY_DEFAULTS = { pos: 'bottom' as const, pos2: 'bottom' as const, size: 1 }
export type CaptionPos = 'top' | 'bottom'
export type CaptionPrefs = {
  on: boolean
  mode: 'word' | 'sentence'
  pos: CaptionPos
  pos2: CaptionPos
  size: number
}
export function loadCaptionPrefs(): CaptionPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(CAPTION_PREFS_KEY) || '{}')
    const pos: CaptionPos = p.pos === 'top' ? 'top' : 'bottom'
    return {
      on: p.on === true,
      // 'line' is the old name for this mode — keep reading it so a saved
      // preference doesn't silently reset.
      mode: p.mode === 'sentence' || p.mode === 'line' ? 'sentence' : 'word',
      pos,
      // Saved before the second track had an edge of its own: it went wherever
      // the main one did, so that is where it stays.
      pos2: p.pos2 === 'top' || p.pos2 === 'bottom' ? p.pos2 : pos,
      // Clamped rather than rejected: a size saved by an older build (the first
      // version of this stepped 50/75/100/150/200/300) is still a size someone
      // chose, and every one of those lands inside the range anyway.
      size: typeof p.size === 'number' && Number.isFinite(p.size)
        ? roundSize(p.size)
        : CAPTION_DISPLAY_DEFAULTS.size,
    }
  } catch {
    return { on: false, mode: 'word', ...CAPTION_DISPLAY_DEFAULTS }
  }
}
