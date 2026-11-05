/**
 * 彈幕 (danmaku): a finished stream's chat flying across the picture, each
 * message entering at the right edge when the video reaches the moment it was
 * sent (see lib/danmaku for the rules of the road).
 *
 * Drawn outside React: a busy stream puts dozens of messages on the screen at
 * once, each moving every frame, and a render per frame for that would be
 * most of the page's work. One loop reads the player, lets in what's due,
 * moves what's flying, and drops what has left.
 *
 * Where each message is comes from the play head alone, so it keeps pace
 * with the playback speed, stands still while paused or buffering, and after
 * a seek the screen shows what it showed at that moment.
 *
 * The chat is the panel's (`useChatReplay`, one fetch per page); this is one
 * more place to show it.
 */
import { useEffect, useRef, type CSSProperties, type RefObject } from 'react'
import { sentBy, type ChatMessage } from './ChatReplay'
import type { PlayerApi } from './LocalControls'
import {
  CROSS_SECONDS, BACK_SEEK_SEC, RESYNC_SEC, SIZE_CQW, SIZE_MIN_PX, fitLanes, laneCount, laneGap, lanePitch, takeLane, type DanmakuPrefs, type Lanes,
} from '../lib/danmaku'

/** One message as it flies: its text and emoji, coloured the way the chat's
 *  names are (the channel yellow, moderators blue, members green), a Super
 *  Chat led by its amount. Null for a message with nothing to show. */
export function danmakuItem(m: ChatMessage): HTMLElement | null {
  const hasText = m.r.some((run) => typeof run !== 'string' || run.trim())
  if (!hasText && !m.p) return null
  const el = document.createElement('div')
  el.className = `danmaku-item${m.b ? ` is-${m.b}` : ''}`
  if (m.p) {
    const paid = document.createElement('span')
    paid.className = 'danmaku-paid'
    paid.textContent = m.p
    el.append(paid)
  }
  for (const run of m.r) {
    if (typeof run === 'string') { el.append(run); continue }
    const img = document.createElement('img')
    img.src = run.e
    img.alt = run.n
    img.draggable = false
    el.append(img)
  }
  return el
}

/** How quickly the drawn play head closes on the player's: the share of the
 *  gap closed per second. */
const EASE_PER_SEC = 2

/** A message that strays from the play head by more than STRAY_FIX seconds
 *  of video runs slower or faster until it's back within STRAY_OK: made up
 *  without a jump, which at a slow speed shows as a lurch, or backwards.
 *  Ahead, it runs NUDGE slower; behind, faster by as much again for every
 *  CATCH_UP_SEC it's behind (up to twice its speed), so a new speed not yet
 *  caught is made up quickly. A few speeds only, the gap between the two
 *  marks keeping it from flicking between them, as each change costs a frame
 *  (see `setRate`). */
const NUDGE = 0.2
const CATCH_UP_SEC = 0.2
const STRAY_FIX = 0.1
const STRAY_OK = 0.02

/** A new speed for a running animation, without stopping it. Written straight
 *  to `playbackRate`, Chrome holds the animation still until the compositor
 *  has it; written every few frames, as a stray was made up, that held every
 *  message still and let it go only once it was half a second behind, to jump
 *  — a stutter at any speed but 1×. `updatePlaybackRate` keeps it going at the
 *  old speed meanwhile. */
const setRate = (a: Animation, rate: number) => {
  if (typeof a.updatePlaybackRate === 'function') a.updatePlaybackRate(rate)
  else a.playbackRate = rate
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

type Flying = {
  el: HTMLElement
  /** When it was sent, in seconds of video. */
  t: number
  w: number
  lane: number
  /** Its crossing, run by the compositor; null where there's no Web
   *  Animations, and the loop moves it instead. */
  anim: Animation | null
  /** How long the crossing takes, in ms of video. */
  span: number
  /** The speed its animation was last asked to run at. */
  rate: number
}

export default function Danmaku({ player, messages, prefs, style }: {
  player: RefObject<PlayerApi | null>
  /** The chat, once it's here; nothing flies before then. */
  messages: ChatMessage[] | null
  prefs: DanmakuPrefs
  /** Where the layer sits beyond its defaults: clear of the panel when the
   *  panel is on the video. */
  style?: CSSProperties
}) {
  const layerRef = useRef<HTMLDivElement>(null)
  const { area, size, speed, opacity } = prefs

  useEffect(() => {
    const layer = layerRef.current
    if (!layer || !messages?.length) return
    const cross = CROSS_SECONDS[speed]
    // How far back a message can have been sent and still be on the screen:
    // the crossing, and as long again for one wider than the picture.
    const reach = cross * 2
    const flying: Flying[] = []
    let lanes: Lanes = []
    // The layer's size and one line's height, read once per change rather
    // than every frame. The text is sized by the player's width, so a bigger
    // player — fullscreen — has taller lines: the lanes are spaced afresh,
    // and what's flying moves to its lane's new height.
    let W = 0
    let H = 0
    let lineH = 0
    const probe = document.createElement('div')
    probe.className = 'danmaku-probe'
    probe.textContent = '彈幕 Mg'
    layer.append(probe)
    // A lane's line sits in the middle of its pitch: the air shared above and below.
    const laneTop = (lane: number) => `${lane * lanePitch(lineH) + (lanePitch(lineH) - lineH) / 2}px`
    const measure = () => {
      const was = { W, lineH }
      W = layer.clientWidth
      H = layer.clientHeight
      lineH = probe.offsetHeight
      if (W === was.W && lineH === was.lineH) return
      lanes = fitLanes(lanes, laneCount(H, lanePitch(lineH)))
      for (const f of flying) {
        f.el.style.top = laneTop(f.lane)
        f.w = f.el.offsetWidth
        fly(f)
      }
    }
    // The play head as this draws it. Over the embed the player says where
    // it is only a few times a second, so between its reports the time is
    // carried on from the last one at the playback speed (`target`), and the
    // drawn head eases toward that rather than jumping to it. Easing, not
    // snapping: a correction then makes the head run a touch faster or
    // slower for a moment, where a jump — or, the head being ahead, a stop —
    // would show as a hitch, plainest at a slow speed, where everything moves
    // only a pixel or so a frame.
    let head: number | null = null
    let reported = Number.NaN
    let reportedAt = 0
    let next = 0
    let lastFrame = performance.now()
    let raf = 0
    // What the animations were last told: whether to run, and how fast.
    let running = false
    let pace = 1

    // Each message's crossing is an animation the compositor runs, at the
    // playback speed, rather than a position this loop writes every frame:
    // the compositor places it a fraction of a pixel at a time and keeps time
    // whatever the page is busy with — at a slow speed, where a message moves
    // a pixel or so a frame, whole-pixel steps or a late frame are what shows.
    // The loop only starts and stops them, and puts back one that strays.
    const fly = (f: Flying) => {
      f.span = ((W + f.w) / W) * cross * 1000
      f.anim?.cancel()
      f.anim = null
      if (typeof f.el.animate !== 'function') return
      const a = f.el.animate(
        [{ transform: `translate3d(${W}px,0,0)` }, { transform: `translate3d(${-f.w}px,0,0)` }],
        { duration: f.span, easing: 'linear', fill: 'both' },
      )
      // Not started yet, so set as it is: it starts at this speed.
      a.playbackRate = pace
      f.rate = pace
      if (!running) a.pause()
      a.currentTime = ((head ?? f.t) - f.t) * 1000
      f.anim = a
    }
    const drop = (f: Flying) => {
      f.anim?.cancel()
      f.el.remove()
    }

    const clear = () => {
      for (const f of flying) drop(f)
      flying.length = 0
      lanes = lanes.map(() => 0)
    }
    // From scratch at `v`: the screen as it was at that moment, every message
    // sent in the reach before it where it would have got to by now.
    const rebuild = (v: number) => {
      clear()
      next = sentBy(messages, (v - reach) * 1000)
    }
    const launch = (m: ChatMessage, v: number, speedPx: number) => {
      const at = m.t / 1000
      // Every lane taken when it was sent: skipped without building anything.
      if (lanes.length && !lanes.some((free) => free <= at)) return
      const el = danmakuItem(m)
      if (!el) return
      el.style.transform = `translate3d(${W}px,0,0)`
      layer.append(el)
      const w = el.offsetWidth
      const lane = takeLane(lanes, at, w, speedPx, laneGap(lineH))
      // No lane, or sent long enough ago that it has already flown past.
      if (lane < 0 || W - (v - at) * speedPx + w < 0) { el.remove(); return }
      el.style.top = laneTop(lane)
      const f: Flying = { el, t: at, w, lane, anim: null, span: 0, rate: pace }
      fly(f)
      flying.push(f)
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const elapsed = Math.min(0.5, (now - lastFrame) / 1000)
      lastFrame = now
      const p = player.current
      if (!p || !W) return
      const r = p.getCurrentTime()
      const playing = p.getPlayerState() === 1
      const rate = p.getPlaybackRate?.() || 1

      // Still, a report is just where it is; playing, when it was said
      // matters too. (Reset while still, or the first report after a pause
      // would read as made long ago, and run the head ahead.)
      if (r !== reported || !playing) { reported = r; reportedAt = now }
      const target = playing ? r + (Math.min(1000, now - reportedAt) / 1000) * rate : r

      // The drawn head never goes back but for a real seek back: the player's
      // time wobbles — a late report, a stall — and every wobble drawn would
      // be the whole screen stepping back.
      let v: number
      if (head === null) v = target
      // A seek back, or a hop forward: straight there.
      else if (target < head - BACK_SEEK_SEC || target - head > RESYNC_SEC) v = target
      // Still: where the player is, or held where it was if that's behind.
      else if (!playing) v = Math.max(head, target)
      // Playing: on at the playback speed, closing on the target — at no
      // less than half the speed and no more than twice, so it neither stops
      // nor jumps.
      else {
        const step = elapsed * rate
        v = head + step + clamp((target - head - step) * Math.min(1, elapsed * EASE_PER_SEC), -step / 2, step)
      }
      // Back, or further forward than anything on the screen reaches: start
      // from scratch at the new moment. A short hop forward needs nothing —
      // what was sent in between comes in where it would be by now.
      if (head === null || v < head || v - head > reach) rebuild(v)
      head = v
      if (lineH) lanes = fitLanes(lanes, laneCount(H, lanePitch(lineH)))

      // Played, paused, or a new speed: every crossing follows.
      if (playing !== running || rate !== pace) {
        running = playing
        pace = rate
        for (const f of flying) {
          if (!f.anim) continue
          setRate(f.anim, rate)
          f.rate = rate
          if (!playing) f.anim.pause()
          else if (f.anim.playState !== 'finished') f.anim.play()
        }
      }

      const speedPx = W / cross
      while (next < messages.length && messages[next].t <= v * 1000) launch(messages[next++], v, speedPx)
      for (let i = flying.length - 1; i >= 0; i--) {
        const f = flying[i]
        const into = (v - f.t) * 1000
        if (into > f.span) { drop(f); flying.splice(i, 1); continue }
        if (!f.anim) {
          f.el.style.transform = `translate3d(${W - (v - f.t) * speedPx}px,0,0)`
          continue
        }
        // Still, or a new speed on its way to the compositor: where it is
        // says nothing yet.
        if (!running || f.anim.pending) continue
        // Seconds of video it has strayed: ahead if more than nothing.
        const stray = (Number(f.anim.currentTime ?? 0) - into) / 1000
        // Well behind — a hop forward: there at once, which is forwards.
        if (stray < -RESYNC_SEC) { f.anim.currentTime = into; continue }
        // Otherwise made up by its speed, a little slower or faster, so it
        // never stops or moves backwards.
        const off = Math.abs(stray)
        const want = off > STRAY_FIX
          ? pace * (stray > 0 ? 1 - NUDGE : 1 + Math.min(1, NUDGE * Math.ceil(off / CATCH_UP_SEC - 1e-9)))
          : off < STRAY_OK ? pace : f.rate
        if (want !== f.rate) { setRate(f.anim, want); f.rate = want }
      }
    }
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(layer)
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      clear()
      probe.remove()
    }
  // The area isn't here: a taller or shorter layer is only a resize, which
  // the lanes follow as they are, so dragging its slider doesn't start over.
  }, [messages, player, size, speed])

  return (
    <div
      ref={layerRef}
      aria-hidden
      data-testid="danmaku"
      className="danmaku pointer-events-none absolute inset-x-0 top-0 z-[5] overflow-hidden"
      style={{
        height: `${area * 100}%`,
        opacity,
        fontSize: `max(${SIZE_MIN_PX * size}px, ${SIZE_CQW * size}cqw)`,
        ...style,
      }}
    />
  )
}
