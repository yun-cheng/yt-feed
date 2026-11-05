/**
 * Where the floating chat sits on the video (ChatOverlay), and how it looks.
 *
 * Position and size are shares of the player box rather than pixels, so the
 * chat keeps its place and proportion when the player grows — a wider window,
 * fullscreen — the way the text in it already scales with the player. Kept in
 * localStorage: a layout preference for this screen, like the panel's side.
 */
export const CHAT_OVERLAY_KEY = 'ytfeed:chat-overlay'

/** How much ground is under the text: none at all (the shadow carries it),
 *  a light tint, or a darker one for a busy picture. */
export type Backdrop = 'none' | 'light' | 'medium'
export const BACKDROPS: readonly Backdrop[] = ['none', 'light', 'medium']

/** Left, top, width and height, each a share (0–1) of the player box. */
export type OverlayBox = { x: number; y: number; w: number; h: number }
export type ChatOverlayPrefs = OverlayBox & {
  /** Whether the chat floats over the video rather than sitting in the panel. */
  on: boolean
  backdrop: Backdrop
}

/** Upper right, out of the way of the captions and the bar, about as wide as
 *  the panel would be but not as tall. */
export const OVERLAY_DEFAULTS: ChatOverlayPrefs = { on: false, x: 0.71, y: 0.06, w: 0.27, h: 0.55, backdrop: 'light' }

/** Small enough to tuck into a corner, large enough to still read a line. */
export const MIN_W = 0.16
export const MIN_H = 0.18

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The box kept whole and inside the player: no smaller than the minimum, no
 *  larger than the player, and nowhere off its edges. */
export function clampBox(b: OverlayBox): OverlayBox {
  const w = clamp(b.w, MIN_W, 1)
  const h = clamp(b.h, MIN_H, 1)
  return { w, h, x: clamp(b.x, 0, 1 - w), y: clamp(b.y, 0, 1 - h) }
}

/** The box after its top strip is dragged by (dx, dy), as shares of the player. */
export function moveBox(b: OverlayBox, dx: number, dy: number): OverlayBox {
  return clampBox({ ...b, x: b.x + dx, y: b.y + dy })
}

/** The box after a lower corner is dragged by (dx, dy). The left corner moves
 *  the left edge, keeping the right one where it was. */
export function resizeBox(b: OverlayBox, corner: 'sw' | 'se', dx: number, dy: number): OverlayBox {
  const h = clamp(b.h + dy, MIN_H, 1 - b.y)
  if (corner === 'se') return clampBox({ ...b, w: clamp(b.w + dx, MIN_W, 1 - b.x), h })
  const right = b.x + b.w
  const x = clamp(b.x + dx, 0, right - MIN_W)
  return clampBox({ x, y: b.y, w: right - x, h })
}

export function nextBackdrop(b: Backdrop): Backdrop {
  return BACKDROPS[(BACKDROPS.indexOf(b) + 1) % BACKDROPS.length]
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

export function loadChatOverlay(): ChatOverlayPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_OVERLAY_KEY) || '{}')
    if (!raw || typeof raw !== 'object') return { ...OVERLAY_DEFAULTS }
    const d = OVERLAY_DEFAULTS
    return {
      on: raw.on === true,
      backdrop: BACKDROPS.includes(raw.backdrop) ? raw.backdrop : d.backdrop,
      ...clampBox({ x: num(raw.x, d.x), y: num(raw.y, d.y), w: num(raw.w, d.w), h: num(raw.h, d.h) }),
    }
  } catch {
    return { ...OVERLAY_DEFAULTS }
  }
}

export function saveChatOverlay(p: ChatOverlayPrefs) {
  try {
    localStorage.setItem(CHAT_OVERLAY_KEY, JSON.stringify(p))
  } catch { /* storage disabled: this visit only */ }
}
