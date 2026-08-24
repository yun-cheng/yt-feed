/**
 * The local player: the <video>-to-PlayerApi adapter, and our own control bar.
 *
 * The bar drives either source — a file we play ourselves, or the YouTube embed
 * with its controls off — so most of these run against both.
 */
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRef } from 'react'
import LocalControls, { localPlayer, previewLeft } from '../components/LocalControls'
import type { PlayerApi } from '../components/LocalControls'
import type { StoryboardInfo } from '../lib/storyboard'

// Two sheets, 5x5 tiles each, over the fakePlayer's 600s — one frame per 12s.
const SB: StoryboardInfo = {
  rows: 5,
  cols: 5,
  frame_width: 160,
  frame_height: 90,
  fragment_urls: ['https://i.ytimg.com/sb/vid/0.jpg', 'https://i.ytimg.com/sb/vid/1.jpg'],
  fragment_duration: 300,
}

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
function renderOverEmbed(
  props: Partial<Parameters<typeof LocalControls>[0]> = {},
  playerOver: Partial<PlayerApi> = {},
) {
  const player = fakePlayer(playerOver)
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

describe('previewLeft — where the popup sits', () => {
  // Asserted on the CSS rather than the element: jsdom discards a `clamp()`
  // outright (the property reads back empty), so the DOM can't answer this.

  it('should follow the cursor through the middle', () => {
    expect(previewLeft(0.5)).toBe('clamp(132px, 50.00%, calc(100% - 132px))')
  })

  it('should stop short of both ends rather than sit flush in the corner', () => {
    // 132 = half the 240px popup, since it's centred on the cursor, + the bar's
    // own 12px gutter — so at either extreme its edge lines up with the end of
    // the TRACK, not the edge of the video. Both terms derive from the popup's
    // width; this is really pinning that they still track it.
    expect(previewLeft(0)).toContain('clamp(132px,')
    expect(previewLeft(1)).toContain('calc(100% - 132px)')
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

  it('shows a storyboard frame over the embed, whose frames are not ours to seek', () => {
    const { container } = renderOverEmbed({ storyboard: SB })
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.pointerMove(bar(container), { clientX: 100, pointerId: 1 })
    // 25% of 600s = 150s = frame 12 of the first sheet: third column, third row,
    // at the scale that renders a 160px tile the popup's 240px across.
    const frame = screen.getByTestId('scrub-storyboard')
    expect(frame).toHaveStyle({
      width: '240px',
      height: '135px',
      backgroundImage: `url(${SB.fragment_urls[0]})`,
      backgroundPosition: '-480px -270px',
      backgroundSize: '1200px 675px',
    })
    // Never a <video> here: there's no file to seek, which is the whole reason
    // the storyboard exists.
    expect(container.querySelector('video')).toBeNull()
  })

  it('falls back to the timestamp alone when the video has no storyboard', () => {
    const { container } = renderOverEmbed()
    expect(screen.queryByTestId('scrub-storyboard')).toBeNull()
    expect(container.querySelector('video')).toBeNull()
  })

  it('keeps the frame while the popup fades out', () => {
    // The popup fades rather than vanishing, so it still renders for a beat
    // after the cursor leaves. Reading the live (now null) hover would snap the
    // picture back to 0:00 on the way out, which reads as a glitch.
    const { container } = renderOverEmbed({ storyboard: SB })
    act(() => { vi.advanceTimersByTime(300) })
    const track = bar(container)
    fireEvent.pointerMove(track, { clientX: 100, pointerId: 1 })
    const during = screen.getByTestId('scrub-storyboard').getAttribute('style')
    fireEvent.pointerLeave(track)
    expect(screen.getByTestId('scrub-storyboard').getAttribute('style')).toBe(during)
  })
})

describe('LocalControls — the resolution label', () => {
  it("shows YouTube's quality as a resolution over the embed", () => {
    const { container } = renderOverEmbed({}, { getPlaybackQuality: () => 'hd1080' })
    act(() => { vi.advanceTimersByTime(300) })
    expect(container).toHaveTextContent('1080p')
  })

  it('shows nothing until the player has settled on one', () => {
    // "unknown" is what the embed reports until playback starts. A label that
    // flickers a word then a number is worse than one that arrives late.
    const { container } = renderOverEmbed({}, { getPlaybackQuality: () => 'unknown' })
    act(() => { vi.advanceTimersByTime(300) })
    expect(container).not.toHaveTextContent(/\d+p/)
  })

  it("reads a file's own height instead of asking about quality", () => {
    // A downloaded file is one resolution and simply knows it — there's no
    // quality to report and localPlayer deliberately has no getPlaybackQuality.
    const videoRef = createRef<HTMLVideoElement>() as { current: HTMLVideoElement | null }
    const el = withDuration(videoEl(), 600)
    Object.defineProperty(el, 'videoHeight', { value: 720, configurable: true })
    videoRef.current = el
    const { container } = render(
      <LocalControls videoRef={videoRef} src="/x" hovering onFullscreen={vi.fn()} />
    )
    expect(container).toHaveTextContent('720p')
  })

  it('sits left of the controls the page supplies', () => {
    // Order in the right-hand group: resolution, then the page's own buttons
    // (the pin), then fullscreen.
    const { container } = renderOverEmbed(
      { extraControls: <button>PIN</button> },
      { getPlaybackQuality: () => 'hd720' }
    )
    act(() => { vi.advanceTimersByTime(300) })
    const text = container.textContent ?? ''
    expect(text.indexOf('720p')).toBeGreaterThan(-1)
    expect(text.indexOf('720p')).toBeLessThan(text.indexOf('PIN'))
  })
})

describe('LocalControls — marks on the track', () => {
  it('draws the bookmarks it is given', () => {
    renderOverEmbed({
      bookmarks: [{ id: 1, position_seconds: 150, note: '' }],
      loop: { a: null, b: null },
    })
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByLabelText('Bookmark at 2:30')).toBeInTheDocument()
  })

  it('a mark seeks to the moment it marks, not to where the click landed', () => {
    const { player } = renderOverEmbed({
      bookmarks: [{ id: 1, position_seconds: 150, note: '' }],
      loop: { a: null, b: null },
    })
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByLabelText('Bookmark at 2:30'))
    expect(player.seekTo).toHaveBeenCalledWith(150, true)
  })

  it('clicking a mark does not also scrub the bar it sits in', () => {
    const { player } = renderOverEmbed({
      bookmarks: [{ id: 1, position_seconds: 150, note: '' }],
      loop: { a: null, b: null },
    })
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.pointerDown(screen.getByLabelText('Bookmark at 2:30'), { pointerId: 1 })
    expect(player.seekTo).not.toHaveBeenCalled()
  })

  it('draws a running loop by dimming the bar either side of it', () => {
    const { container } = renderOverEmbed({
      bookmarks: [],
      loop: { a: 150, b: 450 },   // a quarter and three quarters of the 600s player
    })
    act(() => { vi.advanceTimersByTime(300) })
    const [before, after] = screen.getAllByTestId('loop-dim')
    expect(before).toHaveStyle({ width: '25%' })
    expect(after).toHaveStyle({ left: '75%' })
    expect(container.querySelectorAll('[data-testid="loop-edge"]')).toHaveLength(2)
  })

  it('the loop’s veil dims the fill, and never the play head or a bookmark', () => {
    // Everything in the track paints in document order, which is the whole
    // reason the loop can be a veil at all: it goes over the fill (the part of
    // the played bar you've stopped watching) and under the thumb and the marks
    // (which answer questions the loop has nothing to do with). Reorder this
    // JSX and the loop starts hiding the play head.
    const { container } = renderOverEmbed({
      bookmarks: [{ id: 1, position_seconds: 300, note: '' }],
      loop: { a: 150, b: 450 },
    })
    act(() => { vi.advanceTimersByTime(300) })
    const track = container.querySelector('.bg-white\\/30') as HTMLElement
    const at = (el: Element | null) => [...track.children].indexOf(el as Element)
    const fills = track.querySelectorAll('.bg-red-500')
    const dims = screen.getAllByTestId('loop-dim')

    expect(at(fills[0])).toBeLessThan(at(dims[0]))                       // fill under the veil
    expect(at(dims[1])).toBeLessThan(at(fills[fills.length - 1]))        // thumb over it
    expect(at(dims[1])).toBeLessThan(at(screen.getByLabelText('Bookmark at 5:00')))
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
