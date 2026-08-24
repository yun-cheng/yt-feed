/**
 * Bookmarks and A–B repeat: the state, the shortcuts, and the marks on the bar.
 */
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useRef } from 'react'
import {
  EmbedMarkRail,
  MarkTrack,
  MarksFlash,
  loopActive,
  usePlayerMarks,
} from '../components/PlayerMarks'
import type { Bookmark, Loop } from '../components/PlayerMarks'
import type { PlayerApi } from '../components/LocalControls'

// ── A stand-in player ────────────────────────────────────────────────

function fakePlayer(over: Partial<PlayerApi> = {}) {
  let time = 0
  let state = 1 // playing
  const p = {
    setVolume: vi.fn(), getVolume: () => 100, isMuted: () => false,
    mute: vi.fn(), unMute: vi.fn(),
    playVideo: vi.fn(() => { state = 1 }),
    pauseVideo: vi.fn(() => { state = 2 }),
    getPlayerState: () => state,
    getCurrentTime: () => time,
    getDuration: () => 600,
    seekTo: vi.fn((s: number) => { time = s }),
    _set: (t: number) => { time = t },
    ...over,
  } satisfies PlayerApi & { _set: (t: number) => void }
  return p
}

// ── loopActive ───────────────────────────────────────────────────────

describe('loopActive', () => {
  it('needs both ends', () => {
    expect(loopActive({ a: null, b: null })).toBe(false)
    expect(loopActive({ a: 10, b: null })).toBe(false)
    expect(loopActive({ a: null, b: 20 })).toBe(false)
  })

  it('is active once the ends make sense', () => {
    expect(loopActive({ a: 10, b: 20 })).toBe(true)
  })

  it('rejects a loop too short to be one', () => {
    // Without the floor, a stray `]` right after `[` pins the video to a frame.
    expect(loopActive({ a: 10, b: 10.2 })).toBe(false)
    expect(loopActive({ a: 10, b: 10.5 })).toBe(true)
  })

  it('rejects a backwards loop', () => {
    expect(loopActive({ a: 20, b: 10 })).toBe(false)
  })

  it('accepts a loop that starts at zero', () => {
    // `a: 0` is falsy — a truthiness check here would silently disable it.
    expect(loopActive({ a: 0, b: 10 })).toBe(true)
  })
})

// ── usePlayerMarks ───────────────────────────────────────────────────

function Harness({ player, videoId = 'vid1' }: { player: PlayerApi; videoId?: string }) {
  const ref = useRef<PlayerApi | null>(player)
  const { bookmarks, loop, loopStage, markHere, flash, toggleBookmarkHere, cycleLoop, clearLoop } = usePlayerMarks(videoId, ref)
  return (
    <div>
      <div data-testid="marks">{bookmarks.map((b) => b.position_seconds).join(',')}</div>
      <div data-testid="loop">{`${loop.a ?? '-'}/${loop.b ?? '-'}`}</div>
      <div data-testid="stage">{loopStage}</div>
      <div data-testid="here">{markHere ? 'yes' : 'no'}</div>
      <div data-testid="flash">{flash ?? ''}</div>
      {/* The control bar's buttons, standing in for the real ones: what they
          get from the hook is exactly these three functions. */}
      <button onClick={toggleBookmarkHere}>bookmark</button>
      <button onClick={cycleLoop}>cycle</button>
      <button onClick={clearLoop}>clear</button>
    </div>
  )
}

const key = (k: string) => fireEvent.keyDown(window, { key: k })

/** Render, and wait for the initial bookmark load to land.
 *
 * The hook fetches the video's existing marks on mount and REPLACES state with
 * the result, so a keypress before that lands is overwritten (see the race test
 * below). Every test that presses a key wants to be past it. */
async function renderMarks(player: PlayerApi, videoId = 'vid1') {
  const out = render(<Harness player={player} videoId={videoId} />)
  await act(async () => {})
  return out
}

let posted: Array<Record<string, unknown>>
let deleted: string[]

beforeEach(() => {
  posted = []
  deleted = []
  let nextId = 1
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'POST') {
      const body = JSON.parse(init!.body as string)
      posted.push(body)
      return { ok: true, json: async () => ({ id: nextId++, ...body, note: '' }) } as unknown as Response
    }
    if (method === 'DELETE') {
      deleted.push(input)
      return { ok: true, json: async () => ({ status: 'ok' }) } as unknown as Response
    }
    return { ok: true, json: async () => [] } as unknown as Response
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('usePlayerMarks — bookmarks', () => {
  it('loads the video’s existing bookmarks', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => [{ id: 1, position_seconds: 30, note: '' }],
    } as unknown as Response)
    render(<Harness player={fakePlayer()} />)
    await waitFor(() => expect(screen.getByTestId('marks')).toHaveTextContent('30'))
    expect(fetch).toHaveBeenCalledWith('/api/bookmarks/vid1', {})
  })

  it('survives a response that is not a list', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => ({ detail: 'nope' }),
    } as unknown as Response)
    render(<Harness player={fakePlayer()} />)
    await waitFor(() => expect(screen.getByTestId('marks')).toBeEmptyDOMElement())
  })

  it('b marks the current moment', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(42) })
    act(() => key('b'))
    // Shown immediately, before the POST comes back — a mark that appears a beat
    // after the keypress reads as a dropped one.
    expect(screen.getByTestId('marks')).toHaveTextContent('42')
    await waitFor(() => expect(posted).toEqual([{ video_id: 'vid1', position_seconds: 42 }]))
  })

  it('keeps the list in playback order', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(90) }); act(() => key('b'))
    act(() => { p._set(10) }); act(() => key('b'))
    await waitFor(() => expect(screen.getByTestId('marks')).toHaveTextContent('10,90'))
  })

  it('pressing b again at the same moment removes the mark', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(42) })
    act(() => key('b'))
    await waitFor(() => expect(posted.length).toBe(1))
    act(() => key('b'))
    expect(screen.getByTestId('marks')).toBeEmptyDOMElement()
    await waitFor(() => expect(deleted).toEqual(['/api/bookmarks/id/1']))
  })

  it('removes a mark a second or two away, since you cannot press it precisely', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(42) }); act(() => key('b'))
    await waitFor(() => expect(posted.length).toBe(1))
    act(() => { p._set(43.5) }); act(() => key('b'))
    expect(screen.getByTestId('marks')).toBeEmptyDOMElement()
  })

  it('adds rather than removes once you are clear of the tolerance', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(42) }); act(() => key('b'))
    await waitFor(() => expect(posted.length).toBe(1))
    act(() => { p._set(50) }); act(() => key('b'))
    await waitFor(() => expect(screen.getByTestId('marks')).toHaveTextContent('42,50'))
  })

  it('removes the nearest mark when two are in range', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    // Just over the tolerance apart, so the second press adds rather than
    // removing the first — the start and end of a short phrase.
    act(() => { p._set(40) }); act(() => key('b'))
    await waitFor(() => expect(posted.length).toBe(1))
    act(() => { p._set(43) }); act(() => key('b'))
    await waitFor(() => expect(posted.length).toBe(2))
    // 41.6 is inside the tolerance of both; the 43 one is nearer.
    act(() => { p._set(41.6) }); act(() => key('b'))
    await waitFor(() => expect(screen.getByTestId('marks')).toHaveTextContent('40'))
  })

  it('rolls the mark back when the save fails', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
    act(() => { p._set(42) })
    act(() => key('b'))
    await waitFor(() => expect(screen.getByTestId('marks')).toBeEmptyDOMElement())
  })

  it('does not try to delete a mark that never reached the server', async () => {
    const p = fakePlayer()
    // A POST that never settles: the mark is on screen under its temporary id.
    vi.mocked(fetch).mockImplementationOnce(async () => ({ ok: true, json: async () => [] }) as unknown as Response)
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}) as Promise<Response>)
    await renderMarks(p)
    act(() => { p._set(42) }); act(() => key('b'))
    act(() => key('b'))
    expect(screen.getByTestId('marks')).toBeEmptyDOMElement()
    expect(deleted).toEqual([])
  })

  it('confirms each press on screen', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(65) })
    act(() => key('b'))
    expect(screen.getByTestId('flash')).toHaveTextContent('Bookmarked · 1:05')
    await waitFor(() => expect(posted.length).toBe(1))
    act(() => key('b'))
    expect(screen.getByTestId('flash')).toHaveTextContent('Bookmark removed · 1:05')
  })

  it('starts over when the video changes', async () => {
    const p = fakePlayer()
    const { rerender } = await renderMarks(p, 'vid1')
    act(() => { p._set(42) }); act(() => key('b'))
    await waitFor(() => expect(screen.getByTestId('marks')).toHaveTextContent('42'))
    rerender(<Harness player={p} videoId="vid2" />)
    await waitFor(() => expect(screen.getByTestId('marks')).toBeEmptyDOMElement())
    expect(fetch).toHaveBeenCalledWith('/api/bookmarks/vid2', {})
  })

  it('currently loses a mark made before the existing ones finish loading', async () => {
    // Pins a known wrong answer so a fix is a deliberate change, not a surprise.
    // The load handler REPLACES state with the server's list, so a `b` pressed
    // in the window before it lands is wiped from view. The POST still goes
    // through, so the row is saved and reappears on the next open — but the
    // mark you just made vanishes, which reads as a dropped keypress.
    const p = fakePlayer()
    let land: (v: unknown) => void = () => {}
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise((res) => { land = () => res({ ok: true, json: async () => [] } as unknown as Response) })
    )
    render(<Harness player={p} />)
    act(() => { p._set(42) })
    act(() => key('b'))
    expect(screen.getByTestId('marks')).toHaveTextContent('42')
    await act(async () => { land(null) })
    expect(screen.getByTestId('marks')).toBeEmptyDOMElement()
    // …though it was saved: the POST went out regardless.
    expect(posted).toEqual([{ video_id: 'vid1', position_seconds: 42 }])
  })
})

describe('usePlayerMarks — A–B repeat', () => {
  it('[ and ] set the ends', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(20) }); act(() => key(']'))
    expect(screen.getByTestId('loop')).toHaveTextContent('10/20')
  })

  it('either end can be set first', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(20) }); act(() => key(']'))
    expect(screen.getByTestId('loop')).toHaveTextContent('-/20')
    act(() => { p._set(10) }); act(() => key('['))
    expect(screen.getByTestId('loop')).toHaveTextContent('10/20')
  })

  it('an end can be moved after the fact', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(20) }); act(() => key(']'))
    act(() => { p._set(30) }); act(() => key(']'))
    expect(screen.getByTestId('loop')).toHaveTextContent('10/30')
  })

  it('\\ clears the loop', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(20) }); act(() => key(']'))
    act(() => key('\\'))
    expect(screen.getByTestId('loop')).toHaveTextContent('-/-')
    expect(screen.getByTestId('flash')).toHaveTextContent('Loop cleared')
  })

  it('confirms which end was set', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(65) }); act(() => key('['))
    expect(screen.getByTestId('flash')).toHaveTextContent('Loop A · 1:05')
    act(() => key(']'))
    expect(screen.getByTestId('flash')).toHaveTextContent('Loop B · 1:05')
  })

  it('a loop is about this sitting, so it does not follow the video', async () => {
    const p = fakePlayer()
    const { rerender } = await renderMarks(p, 'vid1')
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(20) }); act(() => key(']'))
    rerender(<Harness player={p} videoId="vid2" />)
    await waitFor(() => expect(screen.getByTestId('loop')).toHaveTextContent('-/-'))
  })
})

describe('usePlayerMarks — the control bar’s buttons', () => {
  const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

  it('the bookmark button marks the moment the play head is on', async () => {
    const p = fakePlayer()
    p._set(42)
    await renderMarks(p)
    await act(async () => { press('bookmark') })
    expect(screen.getByTestId('marks')).toHaveTextContent('42')
    expect(posted).toEqual([{ video_id: 'vid1', position_seconds: 42 }])
  })

  it('and clears it on a second press, exactly as b does', async () => {
    const p = fakePlayer()
    p._set(42)
    await renderMarks(p)
    await act(async () => { press('bookmark') })
    await act(async () => { press('bookmark') })
    expect(screen.getByTestId('marks')).toBeEmptyDOMElement()
    expect(deleted).toHaveLength(1)
  })

  it('the loop button walks A, then B, then clears', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    expect(screen.getByTestId('stage')).toHaveTextContent('idle')

    p._set(10)
    await act(async () => { press('cycle') })
    expect(screen.getByTestId('loop')).toHaveTextContent('10/-')
    expect(screen.getByTestId('stage')).toHaveTextContent('arming')

    p._set(20)
    await act(async () => { press('cycle') })
    expect(screen.getByTestId('loop')).toHaveTextContent('10/20')
    expect(screen.getByTestId('stage')).toHaveTextContent('running')

    await act(async () => { press('cycle') })
    expect(screen.getByTestId('loop')).toHaveTextContent('-/-')
    expect(screen.getByTestId('stage')).toHaveTextContent('idle')
  })

  it('fills in whichever end the keyboard left open', async () => {
    // `]` first, so the button's next press is the START, not another end.
    const p = fakePlayer()
    p._set(30)
    await renderMarks(p)
    key(']')
    p._set(5)
    await act(async () => { press('cycle') })
    expect(screen.getByTestId('loop')).toHaveTextContent('5/30')
  })

  it('a loop too short to run stays armed, so the next press re-pins B', async () => {
    const p = fakePlayer()
    p._set(10)
    await renderMarks(p)
    await act(async () => { press('cycle') })
    p._set(10.2)  // under MIN_LOOP_SEC
    await act(async () => { press('cycle') })
    expect(screen.getByTestId('stage')).toHaveTextContent('arming')
    p._set(15)
    await act(async () => { press('cycle') })
    expect(screen.getByTestId('loop')).toHaveTextContent('10/15')
    expect(screen.getByTestId('stage')).toHaveTextContent('running')
  })

  it('confirms a button press on screen, the same as a keypress', async () => {
    const p = fakePlayer()
    p._set(65)
    await renderMarks(p)
    await act(async () => { press('cycle') })
    expect(screen.getByTestId('flash')).toHaveTextContent('Loop A · 1:05')
    await act(async () => { press('clear') })
    expect(screen.getByTestId('flash')).toHaveTextContent('Loop cleared')
  })
})

describe('usePlayerMarks — standing on a bookmark', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers() })

  const tick = async () => { await act(async () => { vi.advanceTimersByTime(600) }) }

  it('says so once the play head reaches one', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => [{ id: 1, position_seconds: 30, note: '' }],
    } as unknown as Response)
    const p = fakePlayer()
    p._set(10)
    await renderMarks(p)
    await tick()
    expect(screen.getByTestId('here')).toHaveTextContent('no')

    p._set(31)  // inside the tolerance, which is what the button toggles against
    await tick()
    expect(screen.getByTestId('here')).toHaveTextContent('yes')

    p._set(40)
    await tick()
    expect(screen.getByTestId('here')).toHaveTextContent('no')
  })

  it('answers the moment a mark is made or cleared, not on the next tick', async () => {
    // A button that stays on "clear" for half a second after clearing reads as
    // a press that didn't take.
    const p = fakePlayer()
    p._set(42)
    await renderMarks(p)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'bookmark' })) })
    expect(screen.getByTestId('here')).toHaveTextContent('yes')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'bookmark' })) })
    expect(screen.getByTestId('here')).toHaveTextContent('no')
  })
})

describe('usePlayerMarks — the loop tick', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers() })

  const setLoop = (p: ReturnType<typeof fakePlayer>, a: number, b: number) => {
    act(() => { p._set(a) }); act(() => key('['))
    act(() => { p._set(b) }); act(() => key(']'))
  }

  it('seeks back to A on reaching B', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    setLoop(p, 10, 20)
    act(() => { p._set(20.1) })
    act(() => { vi.advanceTimersByTime(250) })
    expect(p.seekTo).toHaveBeenCalledWith(10, true)
  })

  it('leaves playback alone before B', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    setLoop(p, 10, 20)
    act(() => { p._set(15) })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(p.seekTo).not.toHaveBeenCalled()
  })

  it('restarts a player that ended right on B', async () => {
    // A loop ending at the very end hits B as the video ENDS, and seeking a
    // finished player leaves it paused at A.
    const p = fakePlayer({ getPlayerState: () => 0 })
    await renderMarks(p)
    setLoop(p, 10, 20)
    act(() => { p._set(20.1) })
    act(() => { vi.advanceTimersByTime(250) })
    expect(p.playVideo).toHaveBeenCalled()
  })

  it('does not interrupt a player that is already playing', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    setLoop(p, 10, 20)
    act(() => { p._set(20.1) })
    act(() => { vi.advanceTimersByTime(250) })
    expect(p.playVideo).not.toHaveBeenCalled()
  })

  it('does not run for a half-set loop', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(500) })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(p.seekTo).not.toHaveBeenCalled()
  })

  it('stops once the loop is cleared', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    setLoop(p, 10, 20)
    act(() => key('\\'))
    act(() => { p._set(20.1) })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(p.seekTo).not.toHaveBeenCalled()
  })

  it('stops when the player goes away', async () => {
    const p = fakePlayer()
    const { unmount } = await renderMarks(p)
    setLoop(p, 10, 20)
    unmount()
    act(() => { p._set(20.1) })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(p.seekTo).not.toHaveBeenCalled()
  })
})

describe('usePlayerMarks — when the shortcuts must not fire', () => {
  it('ignores keys typed into a text field', () => {
    const p = fakePlayer()
    render(<><Harness player={p} /><input data-testid="field" /></>)
    const field = screen.getByTestId('field')
    fireEvent.keyDown(field, { key: 'b' })
    fireEvent.keyDown(field, { key: '[' })
    expect(screen.getByTestId('marks')).toBeEmptyDOMElement()
    expect(screen.getByTestId('loop')).toHaveTextContent('-/-')
  })

  it('ignores keys typed into a contenteditable', () => {
    const p = fakePlayer()
    render(<><Harness player={p} /><div contentEditable data-testid="rich" /></>)
    const rich = screen.getByTestId('rich')
    // jsdom doesn't implement isContentEditable (it reads undefined however the
    // attribute is set), so the property the guard actually tests has to be
    // supplied by hand.
    Object.defineProperty(rich, 'isContentEditable', { value: true })
    fireEvent.keyDown(rich, { key: 'b' })
    expect(screen.getByTestId('marks')).toBeEmptyDOMElement()
  })

  it('ignores keys it does not own', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { key('a'); key('B'); key('k'); key(' ') })
    expect(screen.getByTestId('marks')).toBeEmptyDOMElement()
    expect(screen.getByTestId('loop')).toHaveTextContent('-/-')
  })

  it('unbinds on unmount', async () => {
    const p = fakePlayer()
    const { unmount } = await renderMarks(p)
    unmount()
    expect(() => key('b')).not.toThrow()
    expect(posted).toEqual([])
  })
})

// ── MarkTrack ────────────────────────────────────────────────────────

const marks: Bookmark[] = [
  { id: 1, position_seconds: 30, note: '' },
  { id: 2, position_seconds: 90, note: '' },
]
const noLoop: Loop = { a: null, b: null }

describe('MarkTrack', () => {
  it('renders nothing before the duration is known', () => {
    // Dividing by 0 would put every mark at NaN%.
    const { container } = render(
      <MarkTrack bookmarks={marks} loop={noLoop} duration={0} onSeek={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('places each mark at its share of the duration', () => {
    render(<MarkTrack bookmarks={marks} loop={noLoop} duration={120} onSeek={vi.fn()} />)
    const [first, second] = screen.getAllByRole('button')
    expect(first).toHaveStyle({ left: '25%' })
    expect(second).toHaveStyle({ left: '75%' })
  })

  it('clamps a mark past the end of a stale duration', () => {
    render(
      <MarkTrack bookmarks={[{ id: 1, position_seconds: 900, note: '' }]}
                 loop={noLoop} duration={120} onSeek={vi.fn()} />
    )
    expect(screen.getByRole('button')).toHaveStyle({ left: '100%' })
  })

  it('centres each mark in its hit area rather than on its left edge', () => {
    // jsdom does no layout, so this pins the class that does the centring: the
    // mark is absolutely positioned inside a 12px-wide hit area, and without a
    // `left` of its own it lands at that area's left edge — every mark drawn
    // 6px before the moment it stands for, and the loop's end caps visibly off
    // the span they cap, which IS positioned directly.
    render(<MarkTrack bookmarks={marks} loop={{ a: 60, b: 90 }} duration={120} onSeek={vi.fn()} />)
    for (const label of ['Bookmark at 0:30', 'Loop start (A) at 1:00', 'Loop end (B) at 1:30']) {
      expect(screen.getByLabelText(label).firstElementChild).toHaveClass('left-1/2', '-translate-x-1/2')
    }
  })

  it('a mark jumps to itself, which is the point of showing them', () => {
    const onSeek = vi.fn()
    render(<MarkTrack bookmarks={marks} loop={noLoop} duration={120} onSeek={onSeek} />)
    fireEvent.click(screen.getAllByRole('button')[1])
    expect(onSeek).toHaveBeenCalledWith(90)
  })

  it('a mark press does not also scrub the bar it sits in', () => {
    // MarkTrack lives inside our control bar's drag handler.
    const onPointerDown = vi.fn()
    render(
      <div onPointerDown={onPointerDown}>
        <MarkTrack bookmarks={marks} loop={noLoop} duration={120} onSeek={vi.fn()} />
      </div>
    )
    fireEvent.pointerDown(screen.getAllByRole('button')[0])
    expect(onPointerDown).not.toHaveBeenCalled()
  })

  it('names each mark for a pointer and a screen reader', () => {
    render(<MarkTrack bookmarks={marks} loop={{ a: 60, b: 90 }} duration={120} onSeek={vi.fn()} />)
    expect(screen.getByLabelText('Loop start (A) at 1:00')).toBeInTheDocument()
    expect(screen.getByLabelText('Loop end (B) at 1:30')).toBeInTheDocument()
    expect(screen.getByLabelText('Bookmark at 0:30')).toBeInTheDocument()
  })

  it('draws the looped span once the loop is really running', () => {
    const { container } = render(
      <MarkTrack bookmarks={[]} loop={{ a: 30, b: 90 }} duration={120} onSeek={vi.fn()} />
    )
    const span = container.querySelector('.bg-yellow-300.absolute') as HTMLElement
    expect(span).toHaveStyle({ left: '25%', right: '25%' })
  })

  it('a half-set loop shows its end cap but paints no span', () => {
    // A colour bar over the rest of the video would claim something is
    // repeating when nothing is.
    const { container } = render(
      <MarkTrack bookmarks={[]} loop={{ a: 30, b: null }} duration={120} onSeek={vi.fn()} />
    )
    expect(container.querySelector('.inset-y-0.bg-yellow-300')).toBeNull()
    expect(screen.getByLabelText('Loop start (A) at 0:30')).toBeInTheDocument()
  })

  it('a loop end jumps to itself too', () => {
    const onSeek = vi.fn()
    render(<MarkTrack bookmarks={[]} loop={{ a: 30, b: 90 }} duration={120} onSeek={onSeek} />)
    fireEvent.click(screen.getByLabelText('Loop start (A) at 0:30'))
    expect(onSeek).toHaveBeenCalledWith(30)
  })

  it('renders nothing to click when there is nothing marked', () => {
    render(<MarkTrack bookmarks={[]} loop={noLoop} duration={120} onSeek={vi.fn()} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})

// ── EmbedMarkRail ────────────────────────────────────────────────────

describe('EmbedMarkRail', () => {
  it('stays out of the way when there is nothing to show', () => {
    const { container } = render(
      <EmbedMarkRail bookmarks={[]} loop={noLoop} duration={120} onSeek={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing before the duration is known', () => {
    const { container } = render(
      <EmbedMarkRail bookmarks={marks} loop={noLoop} duration={0} onSeek={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('sits a fixed distance up from the bottom, not a share of the height', () => {
    // The embed draws its bar a constant distance up; a percentage drifts
    // further out the bigger the window gets.
    const { container } = render(
      <EmbedMarkRail bookmarks={marks} loop={noLoop} duration={120} onSeek={vi.fn()} />
    )
    const rail = container.firstElementChild as HTMLElement
    expect(rail.style.bottom).toMatch(/px$/)
  })

  it('shows a half-set loop, with no bookmarks at all', () => {
    render(<EmbedMarkRail bookmarks={[]} loop={{ a: 30, b: null }} duration={120} onSeek={vi.fn()} />)
    expect(screen.getByLabelText('Loop start (A) at 0:30')).toBeInTheDocument()
  })

  it('the marks themselves stay clickable through the rail', () => {
    // The rail is pointer-events-none so it doesn't swallow clicks meant for
    // YouTube's scrubber underneath; the marks have to opt back in.
    const onSeek = vi.fn()
    render(<EmbedMarkRail bookmarks={marks} loop={noLoop} duration={120} onSeek={onSeek} />)
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(onSeek).toHaveBeenCalledWith(30)
  })
})

// ── MarksFlash ───────────────────────────────────────────────────────

describe('MarksFlash', () => {
  it('shows nothing when there is nothing to say', () => {
    const { container } = render(<MarksFlash flash={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the message', () => {
    render(<MarksFlash flash="Bookmarked · 1:05" />)
    expect(screen.getByText('Bookmarked · 1:05')).toBeInTheDocument()
  })
})
