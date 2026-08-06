/**
 * The local player: the <video>-to-PlayerApi adapter, and our own control bar.
 *
 * The bar drives either source — a file we play ourselves, or the YouTube embed
 * with its controls off — so most of these run against both.
 */
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRef } from 'react'
import LocalControls, { localPlayer } from '../components/LocalControls'
import type { PlayerApi } from '../components/LocalControls'

// ── localPlayer: the adapter ─────────────────────────────────────────

function videoEl(over: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
  const el = document.createElement('video')
  Object.assign(el, { volume: 1, muted: false, currentTime: 0, ...over })
  // jsdom implements neither, and both are one-liners the adapter delegates to.
  el.play = vi.fn().mockResolvedValue(undefined)
  el.pause = vi.fn()
  return el
}

function withDuration(el: HTMLVideoElement, d: number) {
  Object.defineProperty(el, 'duration', { value: d, configurable: true })
  return el
}

describe('localPlayer', () => {
  it('translates volume from YouTube’s 0–100 to the element’s 0–1', () => {
    const el = videoEl()
    const p = localPlayer(el)
    p.setVolume(50)
    expect(el.volume).toBe(0.5)
    expect(p.getVolume()).toBe(50)
  })

  it('clamps volume to the range the element accepts', () => {
    // Out of range throws on a real <video>, so the adapter has to clamp.
    const el = videoEl()
    const p = localPlayer(el)
    p.setVolume(500)
    expect(el.volume).toBe(1)
    p.setVolume(-10)
    expect(el.volume).toBe(0)
  })

  it('mutes and unmutes', () => {
    const el = videoEl()
    const p = localPlayer(el)
    expect(p.isMuted()).toBe(false)
    p.mute()
    expect(el.muted).toBe(true)
    expect(p.isMuted()).toBe(true)
    p.unMute()
    expect(p.isMuted()).toBe(false)
  })

  it('plays and pauses', () => {
    const el = videoEl()
    const p = localPlayer(el)
    p.playVideo()
    expect(el.play).toHaveBeenCalled()
    p.pauseVideo()
    expect(el.pause).toHaveBeenCalled()
  })

  it('swallows a rejected play, which is just the autoplay policy', async () => {
    const el = videoEl()
    el.play = vi.fn().mockRejectedValue(new DOMException('NotAllowed'))
    expect(() => localPlayer(el).playVideo()).not.toThrow()
    await Promise.resolve()
  })

  it('reports YouTube’s state codes', () => {
    const el = videoEl()
    Object.defineProperty(el, 'paused', { value: true, configurable: true })
    Object.defineProperty(el, 'ended', { value: false, configurable: true })
    expect(localPlayer(el).getPlayerState()).toBe(2)  // paused

    Object.defineProperty(el, 'paused', { value: false, configurable: true })
    expect(localPlayer(el).getPlayerState()).toBe(1)  // playing

    Object.defineProperty(el, 'ended', { value: true, configurable: true })
    expect(localPlayer(el).getPlayerState()).toBe(0)  // ended wins over playing
  })

  it('reports a duration of zero until the metadata lands', () => {
    // A fresh <video> reports NaN, and every caller does arithmetic on this.
    const el = withDuration(videoEl(), NaN)
    expect(localPlayer(el).getDuration()).toBe(0)
    expect(localPlayer(withDuration(videoEl(), Infinity)).getDuration()).toBe(0)
    expect(localPlayer(withDuration(videoEl(), 600)).getDuration()).toBe(600)
  })

  it('seeks', () => {
    const el = videoEl()
    localPlayer(el).seekTo(42, true)
    expect(el.currentTime).toBe(42)
    expect(localPlayer(el).getCurrentTime()).toBe(42)
  })
})

// ── The control bar ──────────────────────────────────────────────────

function fakePlayer(over: Partial<PlayerApi> = {}) {
  let time = 0
  let muted = false
  let state = 2
  return {
    setVolume: vi.fn(), getVolume: () => 100,
    isMuted: () => muted,
    mute: vi.fn(() => { muted = true }),
    unMute: vi.fn(() => { muted = false }),
    playVideo: vi.fn(() => { state = 1 }),
    pauseVideo: vi.fn(() => { state = 2 }),
    getPlayerState: () => state,
    getCurrentTime: () => time,
    getDuration: () => 600,
    seekTo: vi.fn((s: number) => { time = s }),
    _set: (t: number) => { time = t },
    _state: (s: number) => { state = s },
    ...over,
  }
}

/** The bar over the embed, which is polled rather than event-driven. */
function renderOverEmbed(props: Partial<Parameters<typeof LocalControls>[0]> = {}) {
  const player = fakePlayer()
  const ref = createRef<PlayerApi | null>() as { current: PlayerApi | null }
  ref.current = player
  const out = render(
    <LocalControls player={ref} hovering onFullscreen={vi.fn()} {...props} />
  )
  return { ...out, player, ref }
}

beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ shouldAdvanceTime: true }) })
afterEach(() => { vi.useRealTimers() })

// The bar measures the track to turn a click into a time; jsdom gives every
// element a zero-size rect, so it has to be supplied. jsdom also has no pointer
// capture, and the drag handler takes it before seeking — without a stub it
// throws and the seek never happens.
function trackAt(el: HTMLElement, left = 0, width = 400) {
  el.getBoundingClientRect = () => ({ left, width, right: left + width, top: 0, bottom: 8, height: 8, x: left, y: 0, toJSON: () => ({}) })
  el.setPointerCapture = vi.fn()
  el.releasePointerCapture = vi.fn()
  return el
}

const bar = (container: HTMLElement) => trackAt(container.querySelector('.group\\/bar') as HTMLElement)

describe('LocalControls — the clock', () => {
  it('shows position and duration', () => {
    const { player } = renderOverEmbed()
    act(() => { player._set(65) })
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByText('1:05 / 10:00')).toBeInTheDocument()
  })

  it('follows the embed by polling, since it never tells us anything', () => {
    const { player } = renderOverEmbed()
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByText('0:00 / 10:00')).toBeInTheDocument()
    act(() => { player._set(30) })
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByText('0:30 / 10:00')).toBeInTheDocument()
  })
})

describe('LocalControls — play and pause', () => {
  it('plays a paused video', () => {
    const { player } = renderOverEmbed()
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTitle('Play (k)'))
    expect(player.playVideo).toHaveBeenCalled()
  })

  it('pauses a playing one', () => {
    const { player } = renderOverEmbed()
    act(() => { player._state(1) })
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTitle('Pause (k)'))
    expect(player.pauseVideo).toHaveBeenCalled()
  })

  it('treats buffering as running, so a stall does not flip the button', () => {
    const { player } = renderOverEmbed()
    act(() => { player._state(3) })
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByTitle('Pause (k)')).toBeInTheDocument()
  })
})

describe('LocalControls — the volume group', () => {
  it('mutes and unmutes', () => {
    const { player } = renderOverEmbed()
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTitle('Mute (m)'))
    expect(player.mute).toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTitle('Unmute (m)'))
    expect(player.unMute).toHaveBeenCalled()
  })

  it('writes to the shared volume, so a level set here follows you', () => {
    renderOverEmbed()
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '40' } })
    expect(JSON.parse(localStorage.getItem('yt-feed-audio-v1')!)).toEqual({ volume: 40 })
  })

  it('dragging off zero unmutes, so the slider is never moving in silence', () => {
    const { player } = renderOverEmbed()
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTitle('Mute (m)'))
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '30' } })
    expect(player.unMute).toHaveBeenCalled()
  })

  it('dragging to zero does not unmute', () => {
    const { player } = renderOverEmbed()
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '0' } })
    expect(player.unMute).not.toHaveBeenCalled()
  })

  it('reads zero while muted, whatever the shared level is', () => {
    const { player } = renderOverEmbed()
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '80' } })
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTitle('Mute (m)'))
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByLabelText('Volume')).toHaveValue('0')
  })
})

describe('LocalControls — scrubbing', () => {
  it('a click on the track seeks to that fraction of the video', () => {
    const { container, player } = renderOverEmbed()
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.pointerDown(bar(container), { clientX: 100, pointerId: 1 })
    expect(player.seekTo).toHaveBeenCalledWith(150, true)  // 25% of 600s
  })

  it('dragging keeps seeking', () => {
    const { container, player } = renderOverEmbed()
    act(() => { vi.advanceTimersByTime(300) })
    const track = bar(container)
    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 200, pointerId: 1 })
    expect(player.seekTo).toHaveBeenLastCalledWith(300, true)
  })

  it('stops seeking once the drag ends', () => {
    const { container, player } = renderOverEmbed()
    act(() => { vi.advanceTimersByTime(300) })
    const track = bar(container)
    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1 })
    fireEvent.pointerUp(track, { pointerId: 1 })
    vi.mocked(player.seekTo).mockClear()
    fireEvent.pointerMove(track, { clientX: 300, pointerId: 1 })
    expect(player.seekTo).not.toHaveBeenCalled()
  })

  it('clamps a drag past either end of the track', () => {
    const { container, player } = renderOverEmbed()
    act(() => { vi.advanceTimersByTime(300) })
    const track = bar(container)
    fireEvent.pointerDown(track, { clientX: -50, pointerId: 1 })
    expect(player.seekTo).toHaveBeenLastCalledWith(0, true)
    fireEvent.pointerMove(track, { clientX: 9999, pointerId: 1 })
    expect(player.seekTo).toHaveBeenLastCalledWith(600, true)
  })

  it('shows the hovered timestamp', () => {
    const { container } = renderOverEmbed()
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.pointerMove(bar(container), { clientX: 200, pointerId: 1 })
    expect(screen.getByText('5:00')).toBeInTheDocument()
  })
})

describe('LocalControls — the scrub preview', () => {
  it('shows a frame of the file when it has one to seek', () => {
    const videoRef = createRef<HTMLVideoElement>() as { current: HTMLVideoElement | null }
    videoRef.current = withDuration(videoEl(), 600)
    const { container } = render(
      <LocalControls videoRef={videoRef} src="/api/local/videos/x/file" hovering onFullscreen={vi.fn()} />
    )
    const preview = container.querySelector('video[src="/api/local/videos/x/file"]')
    expect(preview).toBeInTheDocument()
  })

  it('shows only a timestamp over the embed, whose frames are not ours to seek', () => {
    const { container } = renderOverEmbed()
    expect(container.querySelector('video')).toBeNull()
  })
})

describe('LocalControls — marks on the track', () => {
  it('draws the bookmarks it is given', () => {
    renderOverEmbed({
      bookmarks: [{ id: 1, position_seconds: 150, note: '' }],
      loop: { a: null, b: null },
    })
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByLabelText('Bookmark (press b here to remove) at 2:30')).toBeInTheDocument()
  })

  it('a mark seeks to the moment it marks, not to where the click landed', () => {
    const { player } = renderOverEmbed({
      bookmarks: [{ id: 1, position_seconds: 150, note: '' }],
      loop: { a: null, b: null },
    })
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByLabelText('Bookmark (press b here to remove) at 2:30'))
    expect(player.seekTo).toHaveBeenCalledWith(150, true)
  })

  it('clicking a mark does not also scrub the bar it sits in', () => {
    const { player } = renderOverEmbed({
      bookmarks: [{ id: 1, position_seconds: 150, note: '' }],
      loop: { a: null, b: null },
    })
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.pointerDown(screen.getByLabelText('Bookmark (press b here to remove) at 2:30'), { pointerId: 1 })
    expect(player.seekTo).not.toHaveBeenCalled()
  })

  it('draws no marks when it is given none', () => {
    renderOverEmbed()
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByLabelText(/^Bookmark/)).not.toBeInTheDocument()
  })
})

describe('LocalControls — visibility and extras', () => {
  it('is visible while the pointer is over the player', () => {
    const { container } = renderOverEmbed({ hovering: true })
    expect(container.firstElementChild).toHaveClass('opacity-100')
  })

  it('stays visible while paused, since a paused video with no controls looks broken', () => {
    const { container } = renderOverEmbed({ hovering: false })
    act(() => { vi.advanceTimersByTime(300) })
    expect(container.firstElementChild).toHaveClass('opacity-100')
  })

  it('hides while playing with the pointer away', () => {
    const { container, player } = renderOverEmbed({ hovering: false })
    act(() => { player._state(1) })
    act(() => { vi.advanceTimersByTime(300) })
    expect(container.firstElementChild).toHaveClass('opacity-0')
  })

  it('is the same gradient over either source', () => {
    // It used to go SOLID over the embed, to hide YouTube's share arrow, "More
    // videos" tray and logo sitting on that same line. The extension removes
    // them at the source now, and this bar is only ever drawn over an embed when
    // the extension is installed — so there is nothing left to paint over, and
    // one bar means one look. If this splits again, something is showing through.
    const videoRef = createRef<HTMLVideoElement>() as { current: HTMLVideoElement | null }
    videoRef.current = withDuration(videoEl(), 600)
    const { container: overFile } = render(
      <LocalControls videoRef={videoRef} src="/x" hovering onFullscreen={vi.fn()} />
    )
    const { container: overEmbed } = renderOverEmbed()
    expect(overEmbed.firstElementChild!.className).toContain('from-black/80')
    expect(overEmbed.firstElementChild!.className).not.toContain('via-black')
    expect(overFile.firstElementChild!.className).toBe(overEmbed.firstElementChild!.className)
  })

  it('calls back for fullscreen', () => {
    const onFullscreen = vi.fn()
    renderOverEmbed({ onFullscreen })
    fireEvent.click(screen.getByTitle('Fullscreen (f)'))
    expect(onFullscreen).toHaveBeenCalled()
  })

  it('places the page’s own controls in the row', () => {
    renderOverEmbed({
      leftControls: <button>Captions</button>,
      extraControls: <button>Pin</button>,
    })
    expect(screen.getByRole('button', { name: 'Captions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pin' })).toBeInTheDocument()
  })
})

describe('LocalControls — driving a <video> instead', () => {
  it('follows the element’s own events rather than polling', () => {
    const el = withDuration(videoEl(), 600)
    const videoRef = { current: el }
    render(<LocalControls videoRef={videoRef} src="/x" hovering onFullscreen={vi.fn()} />)
    el.currentTime = 90
    act(() => { fireEvent(el, new Event('timeupdate')) })
    expect(screen.getByText('1:30 / 10:00')).toBeInTheDocument()
  })

  it('seeks the element directly', () => {
    const el = withDuration(videoEl(), 600)
    const { container } = render(
      <LocalControls videoRef={{ current: el }} src="/x" hovering onFullscreen={vi.fn()} />
    )
    act(() => { fireEvent(el, new Event('loadedmetadata')) })
    fireEvent.pointerDown(bar(container), { clientX: 200, pointerId: 1 })
    expect(el.currentTime).toBe(300)
  })

  it('plays the element', () => {
    const el = withDuration(videoEl(), 600)
    render(<LocalControls videoRef={{ current: el }} src="/x" hovering onFullscreen={vi.fn()} />)
    fireEvent.click(screen.getByTitle('Play (k)'))
    expect(el.play).toHaveBeenCalled()
  })
})
