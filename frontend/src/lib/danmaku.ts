/**
 * 彈幕 (danmaku): a stream's chat flying across the picture, each message
 * crossing from right to left when the video reaches the moment it was sent.
 * The pure half: the viewer's settings, and which lane a new message takes
 * (components/Danmaku draws them).
 *
 * Where a message is depends only on the play head: it entered at the right
 * edge at the moment it was sent, and has moved left at one speed since, in
 * seconds of video. So it moves faster at 2×, stands still while paused, and
 * after a seek the screen is what it was at that moment.
 *
 * Every message moves at one speed, so a message can never catch up with the
 * one ahead of it in its lane. A lane is free again once the last message in
 * it has wholly come in from the right edge, plus a gap. A new message takes
 * the lane that has stood free longest, so the chat spreads over all of the
 * area chosen rather than crowding its top. When every lane is
 * taken, the message is skipped: a busy stream sends more than a screen can
 * show, and a message shown late is one that no longer matches the picture.
 */
export const DANMAKU_KEY = 'ytfeed:danmaku'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** How much of the picture's height, from its top, messages may fly over:
 *  a share from AREA_MIN to all of it, in AREA_STEP steps. Captions sit
 *  along the bottom, so the default stops at half. */
export const AREA_MIN = 0.1
export const AREA_STEP = 0.05
/** An area kept to the range and to whole steps. */
export const roundDanmakuArea = (n: number) => Math.round(clamp(n, AREA_MIN, 1) / AREA_STEP) * AREA_STEP

export type DanmakuSpeed = 'slow' | 'normal' | 'fast'
export const DANMAKU_SPEEDS: readonly DanmakuSpeed[] = ['slow', 'normal', 'fast']

export type DanmakuPrefs = {
  on: boolean
  /** A share of the picture's height, from the top. */
  area: number
  /** 0.2–1: how solid the messages are over the picture. */
  opacity: number
  /** A multiplier on the base size, stepped like the captions' (100% is
   *  SIZE_CQW of the player's width). */
  size: number
  speed: DanmakuSpeed
}

export const DANMAKU_DEFAULTS: DanmakuPrefs = { on: false, area: 0.5, opacity: 0.85, size: 1, speed: 'normal' }

export const MIN_OPACITY = 0.2

/** Seconds of video a point takes to cross the picture at 1×: a message's
 *  speed is the picture's width over this, the same for every message on the
 *  screen. */
export const CROSS_SECONDS: Record<DanmakuSpeed, number> = { slow: 11, normal: 8, fast: 5.5 }

/** Text size at 100%, as a share of the player's width (cqw), with a floor in
 *  pixels so a small player still reads. */
export const SIZE_CQW = 2
export const SIZE_MIN_PX = 14
export const SIZE_MIN = 0.5
export const SIZE_MAX = 2
export const SIZE_STEP = 0.1
/** A size kept to the range and to whole tenths, so it prints as 120%, not
 *  120.00000000000001%. */
export const roundDanmakuSize = (n: number) => Math.round(clamp(n, SIZE_MIN, SIZE_MAX) * 10) / 10
// What the first version kept, before the size was a number.
const OLD_SIZES: Record<string, number> = { small: 0.8, medium: 1, large: 1.3 }

/** Lanes are this many lines apart, so the lines have air between them. */
export const LANE_PITCH = 1.4

/** Space left behind a message before the next in its lane: this many line
 *  heights, so it grows with the text — and never less than LANE_GAP_PX. */
export const LANE_GAP_LINES = 2
export const LANE_GAP_PX = 24

/** One lane's height, for text `lineHeightPx` tall. */
export const lanePitch = (lineHeightPx: number) => Math.round(lineHeightPx * LANE_PITCH)
/** The gap behind a message, for text `lineHeightPx` tall. */
export const laneGap = (lineHeightPx: number) => Math.max(LANE_GAP_PX, lineHeightPx * LANE_GAP_LINES)

/** The moment, in seconds of video, from which each lane can take its next
 *  message. */
export type Lanes = number[]

/** How many lanes `pitchPx` apart fit `areaPx` of height, never none. */
export function laneCount(areaPx: number, pitchPx: number): number {
  if (!(pitchPx > 0)) return 1
  return Math.max(1, Math.floor(areaPx / pitchPx))
}

/**
 * The lane a message `widthPx` wide entering at `clock` takes, writing when
 * that lane is next free into `lanes`; or -1 when all are taken. Of the free
 * lanes, the one free longest wins (the topmost, on a tie): a quiet chat
 * then works its way down the area and round again, rather than every
 * message landing in the top two lanes, which come free first.
 */
export function takeLane(lanes: Lanes, clock: number, widthPx: number, speedPx: number, gapPx = LANE_GAP_PX): number {
  let i = -1
  for (let j = 0; j < lanes.length; j++) {
    if (lanes[j] <= clock && (i < 0 || lanes[j] < lanes[i])) i = j
  }
  if (i < 0) return -1
  lanes[i] = clock + (widthPx + gapPx) / speedPx
  return i
}

/** Lanes resized to `n`, keeping what each surviving lane already holds. */
export function fitLanes(lanes: Lanes, n: number): Lanes {
  if (lanes.length === n) return lanes
  return Array.from({ length: n }, (_, i) => lanes[i] ?? 0)
}

/** How far ahead the player's own play head may get of the smoothed one
 *  before the smoothed one jumps to it: a seek forward. Anything less — the
 *  player putting its time right, or a new speed not yet caught — is made up
 *  by running faster for a moment, which reads as speeding up, not a jump. */
export const RESYNC_SEC = 1.5

/** How far back the player's play head must go to count as a seek back, and
 *  the screen be redrawn as it was then. Anything less is the player's time
 *  wobbling, and the screen waits for it rather than stepping back. */
export const BACK_SEEK_SEC = 1

export function loadDanmaku(): DanmakuPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(DANMAKU_KEY) || '{}')
    if (!raw || typeof raw !== 'object') return { ...DANMAKU_DEFAULTS }
    const d = DANMAKU_DEFAULTS
    return {
      on: raw.on === true,
      area: typeof raw.area === 'number' && Number.isFinite(raw.area) ? roundDanmakuArea(raw.area) : d.area,
      opacity: typeof raw.opacity === 'number' && Number.isFinite(raw.opacity) ? clamp(raw.opacity, MIN_OPACITY, 1) : d.opacity,
      size: typeof raw.size === 'number' && Number.isFinite(raw.size) ? roundDanmakuSize(raw.size)
        : typeof raw.size === 'string' && raw.size in OLD_SIZES ? OLD_SIZES[raw.size] : d.size,
      speed: DANMAKU_SPEEDS.includes(raw.speed) ? raw.speed : d.speed,
    }
  } catch {
    return { ...DANMAKU_DEFAULTS }
  }
}

export function saveDanmaku(p: DanmakuPrefs) {
  try {
    localStorage.setItem(DANMAKU_KEY, JSON.stringify(p))
  } catch { /* storage disabled: this visit only */ }
}
