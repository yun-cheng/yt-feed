import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import Danmaku, { DanmakuControl, danmakuItem } from '../components/Danmaku'
import type { ChatMessage } from '../components/ChatReplay'
import type { PlayerApi } from '../components/LocalControls'
import {
  AREA_MIN, DANMAKU_DEFAULTS, DANMAKU_KEY, LANE_GAP_PX, MIN_OPACITY, SIZE_MAX, fitLanes, laneCount, laneGap, lanePitch, loadDanmaku, saveDanmaku, takeLane, trueClock,
  type DanmakuPrefs,
} from '../lib/danmaku'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

// ── The rules of the road ────────────────────────────────────────────

describe('lanes', () => {
  it('fits as many lines as the area holds, and never none', () => {
    expect(laneCount(100, 25)).toBe(4)
    expect(laneCount(99, 25)).toBe(3)
    expect(laneCount(10, 25)).toBe(1)
    expect(laneCount(100, 0)).toBe(1)
  })

  it('gives a message the lane free longest, which stays taken until it has come in', () => {
    const lanes = [0, 0, 0]
    // All free alike: top down.
    expect(takeLane(lanes, 0, 100, 100)).toBe(0)
    // 100px wide and its gap behind it, at 100px a second.
    expect(lanes[0]).toBeCloseTo((100 + LANE_GAP_PX) / 100)
    expect(takeLane(lanes, 0, 50, 100)).toBe(1)
    expect(takeLane(lanes, 0.5, 50, 100)).toBe(2)
    expect(takeLane(lanes, 0.6, 50, 100)).toBe(-1)
    // Lane 1 has come free first, not lane 0.
    expect(takeLane(lanes, 0.8, 50, 100)).toBe(1)
  })

  it('works its way down the area rather than reusing the top lanes as soon as they free', () => {
    const lanes = [0, 0, 0, 0]
    // One short message a second, each lane free again within the second.
    const taken = [0, 1, 2, 3, 4, 5].map((s) => takeLane(lanes, s, 10, 100))
    expect(taken).toEqual([0, 1, 2, 3, 0, 1])
  })

  it('leaves more room behind a message as the text grows', () => {
    expect(laneGap(10)).toBe(LANE_GAP_PX)
    expect(laneGap(40)).toBe(80)
    expect(lanePitch(25)).toBe(35)
    const lanes = [0]
    takeLane(lanes, 0, 100, 100, laneGap(40))
    expect(lanes[0]).toBeCloseTo(1.8)
  })

  it('resizes keeping what each surviving lane holds', () => {
    expect(fitLanes([3, 4, 5], 2)).toEqual([3, 4])
    expect(fitLanes([3], 3)).toEqual([3, 0, 0])
  })
})

describe('danmaku settings', () => {
  it('are kept for next time, and survive a store they can’t read', () => {
    expect(loadDanmaku()).toEqual(DANMAKU_DEFAULTS)
    const mine: DanmakuPrefs = { on: true, area: 1, opacity: 0.5, size: 1.3, speed: 'fast' }
    saveDanmaku(mine)
    expect(loadDanmaku()).toEqual(mine)
    localStorage.setItem(DANMAKU_KEY, JSON.stringify({ on: true, area: 'top', opacity: -4, size: 'huge', speed: 'warp' }))
    expect(loadDanmaku()).toEqual({ ...DANMAKU_DEFAULTS, on: true, opacity: MIN_OPACITY })
    // The area is any share in whole steps, from the least there is to all of it.
    localStorage.setItem(DANMAKU_KEY, JSON.stringify({ area: 0.33 }))
    expect(loadDanmaku().area).toBeCloseTo(0.35)
    localStorage.setItem(DANMAKU_KEY, JSON.stringify({ area: 0 }))
    expect(loadDanmaku().area).toBeCloseTo(AREA_MIN)
    localStorage.setItem(DANMAKU_KEY, JSON.stringify({ area: 0.75 }))
    expect(loadDanmaku().area).toBeCloseTo(0.75)
    // A size past either end stops there, in whole tenths.
    localStorage.setItem(DANMAKU_KEY, JSON.stringify({ size: 9 }))
    expect(loadDanmaku().size).toBe(SIZE_MAX)
    localStorage.setItem(DANMAKU_KEY, JSON.stringify({ size: 1.2000000001 }))
    expect(loadDanmaku().size).toBe(1.2)
    // What the first version kept, a word for the size, still reads.
    localStorage.setItem(DANMAKU_KEY, JSON.stringify({ size: 'large' }))
    expect(loadDanmaku().size).toBe(1.3)
    localStorage.setItem(DANMAKU_KEY, '{oops')
    expect(loadDanmaku()).toEqual(DANMAKU_DEFAULTS)
  })
})

describe('a flying message', () => {
  it('is its text and emoji, coloured as the name would be, a Super Chat led by its amount', () => {
    const el = danmakuItem({ t: 0, a: '@chan', b: 'owner', p: 'NT$150', r: ['gg ', { e: 'https://e/48', n: ':hype:' }] })!
    expect(el).toHaveClass('danmaku-item', 'is-owner')
    expect(el.textContent).toBe('NT$150gg ')
    expect(el.querySelector('.danmaku-paid')?.textContent).toBe('NT$150')
    expect(el.querySelector('img')).toHaveAttribute('src', 'https://e/48')
    expect(el.textContent).not.toContain('@chan')
  })

  it('isn’t made for a message with nothing to show', () => {
    expect(danmakuItem({ t: 0, a: '@x', r: ['  '] })).toBeNull()
    expect(danmakuItem({ t: 0, a: '@x', r: [], p: '$5' })).not.toBeNull()
  })
})

// ── The layer ────────────────────────────────────────────────────────

/** A player whose play head and state the test moves by hand. */
function fakePlayer() {
  const p = { time: 0, state: 1, rate: 1 }
  const api = {
    getCurrentTime: () => p.time,
    getPlayerState: () => p.state,
    getPlaybackRate: () => p.rate,
  } as unknown as PlayerApi
  return { p, ref: { current: api } }
}

/** The embed when something else — another extension — has set the video's
 *  speed: it says `said` and carries its time on at that between the video's
 *  reports of where it really is, every `every` ms. `p` is the truth. */
function speedBehindItsBack(said = 1, every = 500) {
  const { p, ref } = fakePlayer()
  let report = { at: performance.now(), r: p.time }
  ref.current.getPlaybackRate = () => said
  ref.current.getCurrentTime = () => {
    const now = performance.now()
    if (now - report.at >= every) report = { at: now, r: p.time }
    return report.r + (p.state === 1 ? ((now - report.at) / 1000) * said : 0)
  }
  return { p, ref }
}

/** Web Animations as the compositor runs them, stood in for: each frame moves
 *  the running ones on by the frame's time at their own speed. */
type FakeAnim = {
  keyframes: Keyframe[]
  duration: number
  currentTime: number
  playbackRate: number
  /** A new speed waiting on the compositor, as Chrome has it: one written
   *  straight to `playbackRate` holds the animation still until the next
   *  frame; one through `updatePlaybackRate` keeps it going at the old. */
  readonly pending: boolean
  /** How much faster than told the compositor runs it: a clock that drifts. */
  skew: number
  playState: 'running' | 'paused' | 'finished' | 'idle'
  play(): void
  pause(): void
  cancel(): void
  updatePlaybackRate(rate: number): void
  /** The compositor's next frame, `ms` on. */
  step(ms: number): void
}
let anims: FakeAnim[] = []
function fakeCompositor() {
  anims = []
  ;(HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: HTMLElement, keyframes: Keyframe[], opts: KeyframeAnimationOptions) {
    let rate = 1
    // Before its first frame it's waiting to start anyway: a speed set then
    // just starts with it.
    let started = false
    let held = false
    let next: number | null = null
    const a: FakeAnim = {
      keyframes, duration: Number(opts.duration), currentTime: 0, skew: 1, playState: 'running',
      get playbackRate() { return rate },
      set playbackRate(r: number) { rate = r; next = null; if (started && this.playState === 'running') held = true },
      get pending() { return held || next !== null },
      updatePlaybackRate(r: number) { next = r },
      play() { this.playState = 'running' },
      pause() { this.playState = 'paused' },
      cancel() { this.playState = 'idle'; anims = anims.filter((x) => x !== this) },
      step(ms: number) {
        if (this.playState === 'running' && !held) this.currentTime += ms * rate * this.skew
        held = false
        started = true
        if (next !== null) { rate = next; next = null }
      },
    }
    ;(this as unknown as { anim: FakeAnim }).anim = a
    anims.push(a)
    return a
  }
}
afterEach(() => { delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate })

/** Frames run by hand, `ms` apart, with the play head moving along with them
 *  while it plays. */
function frames() {
  let queue: FrameRequestCallback[] = []
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(cb); return queue.length })
  vi.stubGlobal('cancelAnimationFrame', () => { queue = [] })
  return (ms: number, player?: { time: number; state: number; rate: number }, count = 1) => {
    for (let i = 0; i < count; i++) {
      now += ms
      if (player && player.state === 1) player.time += (ms / 1000) * player.rate
      for (const a of anims) a.step(ms)
      const run = queue
      queue = []
      act(() => { run.forEach((cb) => cb(now)) })
    }
  }
}

// The layer 1000 × 200 on screen, every line 25 tall, so lanes 35 apart: five
// lanes, each line 5px down its lane. Every message 100 wide.
beforeEach(() => {
  const size = (prop: 'clientWidth' | 'clientHeight' | 'offsetWidth' | 'offsetHeight', v: (el: HTMLElement) => number) =>
    vi.spyOn(HTMLElement.prototype, prop, 'get').mockImplementation(function (this: HTMLElement) { return v(this) })
  size('clientWidth', (el) => (el.dataset.testid === 'danmaku' ? 1000 : 0))
  size('clientHeight', (el) => (el.dataset.testid === 'danmaku' ? 200 : 0))
  size('offsetWidth', () => 100)
  size('offsetHeight', () => 25)
})

const say = (s: number, text: string): ChatMessage => ({ t: s * 1000, a: '@a', r: [text] })
const flying = () => Array.from(screen.getByTestId('danmaku').querySelectorAll<HTMLElement>('.danmaku-item'))
const px = (transform: unknown) => Number(/translate3d\(([-\d.]+)px/.exec(String(transform))?.[1])
/** Where a message is: its animation's place, or where the loop put it. */
const xOf = (el: HTMLElement) => {
  const a = (el as unknown as { anim?: FakeAnim }).anim
  if (!a || a.playState === 'idle') return px(el.style.transform)
  const from = px(a.keyframes[0].transform)
  const to = px(a.keyframes[1].transform)
  return from + (to - from) * Math.min(1, Math.max(0, a.currentTime / a.duration))
}

describe('the player’s real speed', () => {
  // Frames 16ms apart through an embed told 1× while its video plays at
  // `truth`, reporting where it is every half second.
  const run = (truth: number, ms: number, from = { now: 0, time: 0 }, said = 1, clock = trueClock()) => {
    let { now, time } = from
    let report = { at: now, r: time }
    let out: ReturnType<ReturnType<typeof trueClock>['read']> = null
    for (let t = 0; t < ms; t += 16) {
      now += 16
      time += 0.016 * truth
      if (now - report.at >= 500) report = { at: now, r: time }
      out = clock.read(now, report.r + ((now - report.at) / 1000) * said, said, true)
    }
    return { out, now, time, clock }
  }

  it('is measured from where the player keeps putting its time right', () => {
    const { out, time } = run(1.5, 3000)
    expect(out?.speed).toBeCloseTo(1.5)
    expect(Math.abs(out!.time - time)).toBeLessThan(0.03)
  })

  it('works slower than the player says too', () => {
    const { out, time } = run(0.5, 3000)
    expect(out?.speed).toBeCloseTo(0.5)
    expect(Math.abs(out!.time - time)).toBeLessThan(0.03)
  })

  it('is the player’s own word when that’s right, and again once it’s right again', () => {
    expect(run(1, 3000).out).toBeNull()
    expect(run(1.5, 3000, undefined, 1.5).out).toBeNull()
    const sped = run(1.5, 3000)
    expect(sped.out).not.toBeNull()
    expect(run(1, 2000, sped, 1, sped.clock).out).toBeNull()
  })

  it('starts over on a pause', () => {
    const { clock, now, time } = run(1.5, 3000)
    expect(clock.read(now + 16, time, 1, false)).toBeNull()
    expect(clock.read(now + 32, time, 1, true)).toBeNull()
  })
})

describe('Danmaku', () => {
  const on = { ...DANMAKU_DEFAULTS, on: true }
  // Normal speed crosses the 1000px layer in 8 seconds of video: 125px a second.
  const SPEED = 125

  it('lets a message in at the right edge when the video reaches it, and carries it across while playing', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    render(<Danmaku player={ref} messages={[say(1, 'hello')]} prefs={on} />)
    tick(100, p, 5)
    expect(flying()).toHaveLength(0)

    tick(100, p, 6)
    const [hi] = flying()
    expect(hi.textContent).toBe('hello')
    expect(xOf(hi)).toBeCloseTo(1000 - (p.time - 1) * SPEED)
    const at = xOf(hi)

    // Paused, it stays where it is.
    p.state = 2
    tick(100, p, 5)
    expect(xOf(hi)).toBeCloseTo(at)

    // And once it has wholly gone past the left edge, it's gone.
    p.state = 1
    tick(100, p, 90)
    expect(flying()).toHaveLength(0)
  })

  it('keeps pace with the playback speed', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    render(<Danmaku player={ref} messages={[say(0.5, 'hello')]} prefs={on} />)
    tick(100, p, 7)
    const [hi] = flying()
    const before = xOf(hi)
    p.rate = 2
    tick(100, p)
    // A tenth of a second at 2× is a fifth of one of video.
    expect(before - xOf(hi)).toBeCloseTo(SPEED * 0.2)
  })

  it('moves smoothly at a slow speed, though the player says where it is only now and then', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    // The embed's way: the play head reported in quarter-second steps.
    const exact = ref.current.getCurrentTime
    ref.current.getCurrentTime = () => Math.floor(exact() * 4) / 4
    p.rate = 0.25
    render(<Danmaku player={ref} messages={[say(0.1, 'slow')]} prefs={on} />)
    tick(16, p, 60)
    const [el] = flying()
    const xs: number[] = []
    for (let i = 0; i < 120; i++) { tick(16, p); xs.push(xOf(el)) }
    const steps = xs.slice(1).map((x, i) => xs[i] - x)
    // Every frame moves on, and by about as much as any other: no stops, no lurches.
    expect(Math.min(...steps)).toBeGreaterThan(0)
    expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(2)
    // And it's where the video says, give or take a few frames.
    expect(Math.abs(xOf(el) - (1000 - (p.time - 0.1) * SPEED))).toBeLessThan(10)
  })

  it('stacks messages sent together in lanes from the top, skipping what doesn’t fit', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    const burst = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => say(0.5, x))
    render(<Danmaku player={ref} messages={burst} prefs={on} />)
    tick(100, p, 7)
    expect(flying().map((el) => el.textContent)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(flying().map((el) => el.style.top)).toEqual(['5px', '40px', '75px', '110px', '145px'])
  })

  it('spaces its lanes afresh when the player grows, as in fullscreen, moving what’s flying with them', () => {
    const tick = frames()
    let resized = () => {}
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resized = cb } observe() {} disconnect() {} })
    const { p, ref } = fakePlayer()
    render(<Danmaku player={ref} messages={['a', 'b', 'c'].map((x) => say(0.5, x))} prefs={on} />)
    tick(100, p, 7)
    expect(flying().map((el) => el.style.top)).toEqual(['5px', '40px', '75px'])

    // The text is sized by the player's width: a bigger player, taller lines
    // (40 tall, so lanes 56 apart).
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40)
    resized()
    expect(flying().map((el) => el.style.top)).toEqual(['8px', '64px', '120px'])
  })

  it('after a hop forward, shows what was sent in between where it would be by now', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    render(<Danmaku player={ref} messages={[say(1, 'first'), say(2.5, 'second')]} prefs={on} />)
    tick(100, p, 12)
    const [first] = flying()
    p.time += 2
    tick(100, p)
    const [stillFirst, second] = flying()
    // Nothing cleared: the same message, moved on by the hop.
    expect(stillFirst).toBe(first)
    expect(xOf(first)).toBeCloseTo(1000 - (p.time - 1) * SPEED)
    expect(second.textContent).toBe('second')
    expect(xOf(second)).toBeCloseTo(1000 - (p.time - 2.5) * SPEED)
  })

  it('after a hop back, shows the screen as it was at that moment', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    render(<Danmaku player={ref} messages={[say(0.5, 'early'), say(3, 'later')]} prefs={on} />)
    tick(100, p, 40)
    expect(flying().map((el) => el.textContent)).toEqual(['early', 'later'])
    p.time = 1
    tick(100, p)
    expect(flying().map((el) => el.textContent)).toEqual(['early'])
    expect(xOf(flying()[0])).toBeCloseTo(1000 - (p.time - 0.5) * SPEED)
  })

  it('opens on the screen as it is at the play head, not on the stream’s start', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    p.time = 100
    render(<Danmaku player={ref} messages={[say(5, 'old'), say(95, 'recent'), say(100.3, 'new')]} prefs={on} />)
    tick(100, p)
    expect(flying().map((el) => el.textContent)).toEqual(['recent'])
    tick(100, p, 3)
    expect(flying().map((el) => el.textContent)).toEqual(['recent', 'new'])
  })

  it('skips what a long jump passes over', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    render(<Danmaku player={ref} messages={[say(0.5, 'early'), say(30, 'skipped'), say(60.5, 'later')]} prefs={on} />)
    tick(100, p, 7)
    p.time = 60
    tick(100, p, 7)
    expect(flying().map((el) => el.textContent)).toEqual(['later'])
  })
})

describe('Danmaku on the compositor', () => {
  const on = { ...DANMAKU_DEFAULTS, on: true }
  const SPEED = 125
  beforeEach(fakeCompositor)

  it('hands each crossing to an animation, which pauses and keeps pace with the video', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    render(<Danmaku player={ref} messages={[say(0.5, 'hello')]} prefs={on} />)
    tick(100, p, 7)
    const [hi] = flying()
    expect(anims).toHaveLength(1)
    // 1000px in, its own 100px out, at 125px a second of video.
    expect(anims[0].duration).toBeCloseTo(((1000 + 100) / SPEED) * 1000)
    expect(xOf(hi)).toBeCloseTo(1000 - (p.time - 0.5) * SPEED)

    p.state = 2
    tick(100, p, 3)
    expect(anims[0].playState).toBe('paused')
    const still = xOf(hi)
    tick(100, p, 3)
    expect(xOf(hi)).toBeCloseTo(still)

    p.state = 1
    p.rate = 0.5
    tick(100, p, 5)
    expect(anims[0].playbackRate).toBeCloseTo(0.5, 1)
    // A second of play at half speed is half a second of crossing.
    const at = xOf(hi)
    tick(100, p, 10)
    expect(Math.abs(at - xOf(hi) - SPEED * 0.5)).toBeLessThan(5)
  })

  it('never moves a message backwards while playing, however the player’s time wobbles', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    // A player whose reports come late — now by a little, now by a lot — and
    // a compositor that runs a touch fast.
    const exact = ref.current.getCurrentTime
    let n = 0
    ref.current.getCurrentTime = () => exact() - [0, 0.3, 0.05, 0.6, 0.1, 0][n++ % 6] * p.rate
    p.rate = 0.25
    render(<Danmaku player={ref} messages={[say(0.2, 'a'), say(0.4, 'b'), say(0.6, 'c')]} prefs={on} />)
    tick(16, p, 200)
    for (const a of anims) a.skew = 1.1
    const last = new Map<HTMLElement, number>()
    for (let i = 0; i < 400; i++) {
      tick(16, p)
      for (const el of flying()) {
        const x = xOf(el)
        if (last.has(el)) expect(x).toBeLessThanOrEqual(last.get(el)! + 1e-6)
        last.set(el, x)
      }
    }
    // And for all that, where the video says it should be.
    const [a] = flying()
    expect(Math.abs(xOf(a) - (1000 - (p.time - 0.2) * SPEED))).toBeLessThan(15)
  })

  it('keeps every message moving, step by even step, through a change of speed', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    render(<Danmaku player={ref} messages={[say(0.2, 'a'), say(0.5, 'b'), say(0.9, 'c')]} prefs={on} />)
    tick(16, p, 90)
    // Sped up, on a compositor whose clock runs a little fast.
    p.rate = 1.5
    for (const a of anims) a.skew = 1.03
    const last = new Map<HTMLElement, number>()
    for (let i = 0; i < 240; i++) {
      tick(16, p)
      for (const el of flying()) {
        const x = xOf(el)
        if (i > 2 && last.has(el)) {
          // At 1.5×, 125px a second of video moves 3px a frame: never
          // standing still, never leaping.
          const moved = last.get(el)! - x
          expect(moved).toBeGreaterThan(1)
          expect(moved).toBeLessThan(5)
        }
        last.set(el, x)
      }
    }
    const [a] = flying()
    expect(Math.abs(xOf(a) - (1000 - (p.time - 0.2) * SPEED))).toBeLessThan(15)
  })

  it('moves evenly at a speed the player doesn’t know it’s playing at', () => {
    const tick = frames()
    const { p, ref } = speedBehindItsBack()
    p.rate = 1.5
    render(<Danmaku player={ref} messages={[say(0.2, 'a'), say(0.5, 'b'), say(0.9, 'c'), say(2.5, 'd')]} prefs={on} />)
    // A second and a half to learn the speed from the player's corrections.
    tick(16, p, 100)
    const last = new Map<HTMLElement, number>()
    for (let i = 0; i < 240; i++) {
      tick(16, p)
      for (const el of flying()) {
        const x = xOf(el)
        if (i > 2 && last.has(el)) {
          // 125px a second of video at 1.5× is 3px a frame.
          const moved = last.get(el)! - x
          expect(moved).toBeGreaterThan(2)
          expect(moved).toBeLessThan(4)
        }
        last.set(el, x)
      }
    }
    const a = flying().find((el) => el.textContent === 'd')!
    expect(Math.abs(xOf(a) - (1000 - (p.time - 2.5) * SPEED))).toBeLessThan(10)
  })

  it('speeds up to a new speed set behind the player’s back without a jump, and keeps up', () => {
    const tick = frames()
    const { p, ref } = speedBehindItsBack()
    const msgs = Array.from({ length: 40 }, (_, i) => say(0.3 + i * 0.6, `m${i}`))
    render(<Danmaku player={ref} messages={msgs} prefs={on} />)
    tick(16, p, 60)
    const last = new Map<HTMLElement, number>()
    const watch = (frames: number) => {
      for (let i = 0; i < frames; i++) {
        tick(16, p)
        for (const el of flying()) {
          const x = xOf(el)
          // Never back, never a jump: at most twice 2× at 125px a second,
          // 8px a frame (a jump of even a quarter second is 31px).
          if (last.has(el)) {
            expect(last.get(el)! - x).toBeGreaterThan(0)
            expect(last.get(el)! - x).toBeLessThan(8.5)
          }
          last.set(el, x)
        }
      }
    }
    p.rate = 2
    watch(150)
    p.rate = 1.25
    watch(150)
    const caught = flying().at(-1)!
    const sent = msgs.find((m) => m.r[0] === caught.textContent)!.t / 1000
    expect(Math.abs(xOf(caught) - (1000 - (p.time - sent) * SPEED))).toBeLessThan(10)
  })

  it('redraws the screen on a real seek back, and only then', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    render(<Danmaku player={ref} messages={[say(0.5, 'early'), say(3, 'later')]} prefs={on} />)
    tick(100, p, 40)
    const before = flying()
    // Half a second back: the player's time wobbling, not a seek.
    p.time -= 0.5
    tick(100, p)
    const after = flying()
    expect(after).toHaveLength(before.length)
    after.forEach((el, i) => expect(el).toBe(before[i]))
    // Two seconds back: a seek, and the screen as it was then.
    p.time = 1
    tick(100, p)
    expect(flying().map((el) => el.textContent)).toEqual(['early'])
  })

  it('glides evenly at a slow speed, though the player says where it is only now and then', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    const exact = ref.current.getCurrentTime
    ref.current.getCurrentTime = () => Math.floor(exact() * 4) / 4
    p.rate = 0.25
    render(<Danmaku player={ref} messages={[say(0.1, 'slow')]} prefs={on} />)
    tick(16, p, 60)
    const [el] = flying()
    const xs: number[] = []
    for (let i = 0; i < 120; i++) { tick(16, p); xs.push(xOf(el)) }
    const steps = xs.slice(1).map((x, i) => xs[i] - x)
    for (const step of steps) expect(step).toBeCloseTo(SPEED * 0.016 * 0.25)
  })

  it('puts a crossing back where it belongs after a hop forward', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    render(<Danmaku player={ref} messages={[say(0.5, 'hello')]} prefs={on} />)
    tick(100, p, 7)
    p.time += 2
    tick(100, p)
    expect(xOf(flying()[0])).toBeCloseTo(1000 - (p.time - 0.5) * SPEED)
  })

  it('crosses the new width once the player grows, from where it had got to', () => {
    const tick = frames()
    let resized = () => {}
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resized = cb } observe() {} disconnect() {} })
    const { p, ref } = fakePlayer()
    render(<Danmaku player={ref} messages={[say(0.5, 'hello')]} prefs={on} />)
    tick(100, p, 7)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(2000)
    resized()
    const [hi] = flying()
    expect(anims).toHaveLength(1)
    expect(px(anims[0].keyframes[0].transform)).toBe(2000)
    // The same share of the way across: twice the width, twice the speed.
    expect(xOf(hi)).toBeCloseTo(2000 - (p.time - 0.5) * SPEED * 2)
  })

  it('lets go of a crossing once it has left the picture', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    render(<Danmaku player={ref} messages={[say(0.5, 'hello')]} prefs={on} />)
    tick(100, p, 100)
    expect(flying()).toHaveLength(0)
    expect(anims).toHaveLength(0)
  })
})

describe('Danmaku’s area', () => {
  it('is the share of the picture’s height it covers, and changing it keeps what’s flying', () => {
    const tick = frames()
    const { p, ref } = fakePlayer()
    const chat = [say(0.5, 'hello')]
    const view = render(<Danmaku player={ref} messages={chat} prefs={{ ...DANMAKU_DEFAULTS, on: true, area: 0.35 }} />)
    expect(screen.getByTestId('danmaku').style.height).toBe('35%')
    tick(100, p, 7)
    const [hi] = flying()
    view.rerender(<Danmaku player={ref} messages={chat} prefs={{ ...DANMAKU_DEFAULTS, on: true, area: 0.9 }} />)
    expect(screen.getByTestId('danmaku').style.height).toBe('90%')
    expect(flying()[0]).toBe(hi)
  })
})

// ── Its button ───────────────────────────────────────────────────────

describe('DanmakuControl', () => {
  const mount = (prefs: Partial<DanmakuPrefs> = {}, chat: 'done' | 'running' = 'done') => {
    const onPrefs = vi.fn()
    render(<DanmakuControl prefs={{ ...DANMAKU_DEFAULTS, ...prefs }} onPrefs={onPrefs} chat={chat} buttonClass="" />)
    return onPrefs
  }

  it('stops the size at its ends', () => {
    mount({ size: SIZE_MAX })
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Turn danmaku on' }).parentElement!, { pointerType: 'mouse' })
    expect(screen.getByRole('button', { name: 'Bigger danmaku' })).toBeDisabled()
  })

  it('turns on and off with a click', () => {
    const onPrefs = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Turn danmaku on' }))
    expect(onPrefs).toHaveBeenCalledWith({ ...DANMAKU_DEFAULTS, on: true })
  })

  it('opens its settings on hover: where, how big, how fast, how solid', () => {
    const onPrefs = mount({ on: true })
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Turn danmaku off' }).parentElement!, { pointerType: 'mouse' })
    // How much of the screen: a share, from a slider.
    expect(screen.getByRole('slider', { name: 'Display area' })).toHaveValue('50')
    fireEvent.change(screen.getByRole('slider', { name: 'Display area' }), { target: { value: '80' } })
    expect(onPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ area: 0.8 }))
    // Size steps by tenths from 100%, like the captions'.
    expect(screen.getByText('100%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Bigger danmaku' }))
    expect(onPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ size: 1.1 }))
    fireEvent.click(screen.getByRole('button', { name: 'Smaller danmaku' }))
    expect(onPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ size: 0.9 }))
    fireEvent.click(screen.getByRole('radio', { name: 'Fast' }))
    expect(onPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 'fast' }))
    fireEvent.change(screen.getByRole('slider', { name: 'Opacity' }), { target: { value: '40' } })
    expect(onPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ opacity: 0.4 }))
  })

  it('says why nothing flies while the chat is still being fetched', () => {
    mount({ on: true }, 'running')
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Turn danmaku off' }).parentElement!, { pointerType: 'mouse' })
    expect(screen.getByText('Fetching the chat replay…')).toBeInTheDocument()
  })

  it('opens its settings on a tap, whose switch does what a click would', () => {
    const onPrefs = mount()
    const button = screen.getByRole('button', { name: 'Turn danmaku on' })
    fireEvent.pointerDown(button, { pointerType: 'touch' })
    fireEvent.click(button)
    expect(onPrefs).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch'))
    expect(onPrefs).toHaveBeenCalledWith({ ...DANMAKU_DEFAULTS, on: true })
  })
})
