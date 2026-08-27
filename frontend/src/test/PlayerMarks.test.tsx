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
  loopBounds,
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

// ── loopBounds ───────────────────────────────────────────────────────

const LEN = 120

describe('loopBounds', () => {
  it('needs at least one end', () => {
    expect(loopBounds({ a: null, b: null }, LEN)).toBeNull()
    expect(loopActive({ a: null, b: null }, LEN)).toBe(false)
  })

  it('runs between the ends once both are pinned', () => {
    expect(loopBounds({ a: 10, b: 20 }, LEN)).toEqual({ a: 10, b: 20 })
  })

  it('an unpinned A is the start of the video', () => {
    // `]` on its own reads as "repeat up to here", and does.
    expect(loopBounds({ a: null, b: 20 }, LEN)).toEqual({ a: 0, b: 20 })
  })

  it('an unpinned B is the end of it', () => {
    // And `[` on its own as "repeat from here".
    expect(loopBounds({ a: 10, b: null }, LEN)).toEqual({ a: 10, b: LEN })
  })

  it('waits for a player that does not know the length yet', () => {
    // A duration of 0 is "ask me again", not a video of no length.
    expect(loopBounds({ a: 10, b: null }, 0)).toBeNull()
  })

  it('rejects a loop too short to be one', () => {
    // Without the floor, a stray `]` right after `[` pins the video to a frame.
    expect(loopBounds({ a: 10, b: 10.2 }, LEN)).toBeNull()
    expect(loopBounds({ a: 10, b: 10.5 }, LEN)).toEqual({ a: 10, b: 10.5 })
    // Which covers `[` pressed in the last half-second, too.
    expect(loopBounds({ a: LEN - 0.2, b: null }, LEN)).toBeNull()
  })

  it('rejects a backwards loop', () => {
    expect(loopBounds({ a: 20, b: 10 }, LEN)).toBeNull()
  })

  it('accepts a loop that starts at zero', () => {
    // `a: 0` is falsy — a truthiness check here would silently disable it.
    expect(loopBounds({ a: 0, b: 10 }, LEN)).toEqual({ a: 0, b: 10 })
  })
})

// ── usePlayerMarks ───────────────────────────────────────────────────

function Harness({ player, videoId = 'vid1' }: { player: PlayerApi; videoId?: string }) {
  const ref = useRef<PlayerApi | null>(player)
  const { bookmarks, loop, loopStage, looping, markHere, flash, toggleBookmarkHere, cycleLoop, clearLoop } = usePlayerMarks(videoId, ref)
  return (
    <div>
      <div data-testid="marks">{bookmarks.map((b) => b.position_seconds).join(',')}</div>
      <div data-testid="loop">{`${loop.a ?? '-'}/${loop.b ?? '-'}`}</div>
      <div data-testid="stage">{loopStage}</div>
      <div data-testid="looping">{looping ? 'yes' : 'no'}</div>
      <div data-testid="here">{markHere ? 'yes' : 'no'}</div>
      <div data-testid="flash">{flash?.text ?? ''}</div>
      {/* The control bar's buttons, standing in for the real ones: what they
          get from the hook is exactly these three functions. */}
      <button onClick={toggleBookmarkHere}>bookmark</button>
      <button onClick={cycleLoop}>cycle</button>
      <button onClick={clearLoop}>clear</button>
    </div>
  )
}

const key = (k: string) => fireEvent.keyDown(window, { key: k })
const chord = (k: string, mod: 'metaKey' | 'ctrlKey' | 'altKey' = 'metaKey') =>
  fireEvent.keyDown(window, { key: k, [mod]: true })

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

  it('repeats from A to the end of the video', async () => {
    // `[` on its own reads as "repeat from here", and a press that does nothing
    // until you make a second one is a press you stop making.
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    expect(screen.getByTestId('looping')).toHaveTextContent('yes')
  })

  it('repeats from the start of it to B', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(20) }); act(() => key(']'))
    expect(screen.getByTestId('looping')).toHaveTextContent('yes')
  })

  it('says so the moment the end is pinned, not at the next poll', async () => {
    // The duration is polled, but it's read straight off the player here: half a
    // second of a button not admitting it started reads as a dropped press.
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    expect(screen.getByTestId('looping')).toHaveTextContent('yes')
  })

  it('and still asks the button for the other end', async () => {
    // Repeating and half-pinned at once is the ordinary state of a one-ended
    // loop: the badge says which end the next press takes.
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    expect(screen.getByTestId('stage')).toHaveTextContent('arming')
    expect(screen.getByTestId('looping')).toHaveTextContent('yes')
  })

  it('is not repeating once the loop is cleared', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    act(() => key('\\'))
    expect(screen.getByTestId('looping')).toHaveTextContent('no')
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

  it('and removes it on a second press, exactly as b does', async () => {
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

  it('lets go when the video changes', async () => {
    // The new video's marks haven't arrived yet, and a button offering to clear
    // a bookmark that isn't there is a button telling you something untrue.
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => [{ id: 1, position_seconds: 30, note: '' }],
    } as unknown as Response)
    const p = fakePlayer()
    p._set(30)
    const { rerender } = await renderMarks(p)
    await tick()
    expect(screen.getByTestId('here')).toHaveTextContent('yes')

    rerender(<Harness player={p} videoId="vid2" />)
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

  it('runs to the end of the video when only A is pinned', async () => {
    const p = fakePlayer()  // 600s long
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(500) })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(p.seekTo).not.toHaveBeenCalled()  // 500 is not the end yet
    act(() => { p._set(600) })
    act(() => { vi.advanceTimersByTime(250) })
    expect(p.seekTo).toHaveBeenCalledWith(10, true)
  })

  it('runs from the start of it when only B is pinned', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(20) }); act(() => key(']'))
    act(() => { p._set(20.1) })
    act(() => { vi.advanceTimersByTime(250) })
    expect(p.seekTo).toHaveBeenCalledWith(0, true)
  })

  it('takes a video ending as reaching the end it was told to loop to', async () => {
    // The player can stop a hair short of the duration it reported, and then
    // nothing ever passes B.
    const p = fakePlayer({ getPlayerState: () => 0 })
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(599.8) })
    act(() => { vi.advanceTimersByTime(250) })
    expect(p.seekTo).toHaveBeenCalledWith(10, true)
    expect(p.playVideo).toHaveBeenCalled()
  })

  it('does not run before the player knows how long the video is', async () => {
    const p = fakePlayer({ getDuration: () => 0 })
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

  it('leaves ⌘/Ctrl/Alt chords to the browser', async () => {
    // ⌘B is the bookmarks bar, and on a Mac ⌘[ and ⌘] are back and forward.
    // Matching on `key` alone swallowed all three — and, in the sibling handler
    // on the watch page, ⌘C, which is how somebody copies text out of the page.
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { chord('b'); chord('['); chord(']'); chord('\\') })
    act(() => { chord('b', 'ctrlKey'); chord('b', 'altKey') })
    expect(screen.getByTestId('marks')).toBeEmptyDOMElement()
    expect(screen.getByTestId('loop')).toHaveTextContent('-/-')
    expect(posted).toEqual([])
  })

  it('still fires on the bare key', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { key('[') })
    expect(screen.getByTestId('loop')).not.toHaveTextContent('-/-')
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

  it('centres a bookmark tick in its hit area rather than on its left edge', () => {
    // jsdom does no layout, so this pins the class that does the centring: the
    // tick is absolutely positioned inside a 12px-wide hit area, and without a
    // `left` of its own it lands at that area's left edge — the mark drawn 6px
    // before the moment it stands for.
    render(<MarkTrack bookmarks={marks} loop={noLoop} duration={120} onSeek={vi.fn()} />)
    expect(screen.getByLabelText('Bookmark at 0:30').firstElementChild)
      .toHaveClass('left-1/2', '-translate-x-1/2')
  })

  it('grows the tick while the pointer is in its hit area', () => {
    // jsdom has no :hover, so this pins the pairing that does it: the hit area
    // is the named group, the tick reacts to it. What grows is the tick, not
    // the target — over the embed it's YouTube's own scrubber we'd be taking.
    render(<MarkTrack bookmarks={marks} loop={noLoop} duration={120} onSeek={vi.fn()} />)
    const mark = screen.getByLabelText('Bookmark at 0:30')
    expect(mark).toHaveClass('group/mark')
    expect(mark.firstElementChild).toHaveClass('group-hover/mark:h-[18px]', 'group-hover/mark:w-[8px]')
  })

  it('gives bookmarks a colour of their own, and the loop none', () => {
    // A bookmark is a mark, so it wears one hue everywhere it appears; the loop
    // is a mode of the bar, and adding a second colour to red/white/black is
    // what makes a player look like it has been drawn on.
    const { container } = render(
      <MarkTrack bookmarks={marks} loop={{ a: 60, b: 90 }} duration={120} onSeek={vi.fn()} />
    )
    expect(screen.getByLabelText('Bookmark at 0:30').firstElementChild).toHaveClass('bg-sky-400')
    for (const el of container.querySelectorAll('[data-testid^="loop-"]')) {
      expect(el.className).toMatch(/bg-black\//)
    }
  })

  it('dims the track either side of a running loop, and nothing else', () => {
    // The loop is the stretch left at full strength. The veil covers the fill
    // too — the played part outside the loop is the part you've stopped
    // watching — and the thumb and any bookmarks are drawn after it.
    render(<MarkTrack bookmarks={[]} loop={{ a: 30, b: 90 }} duration={120} onSeek={vi.fn()} />)
    const [before, after] = screen.getAllByTestId('loop-dim')
    expect(before).toHaveClass('left-0')
    expect(before).toHaveStyle({ width: '25%' })
    expect(after).toHaveClass('right-0')
    expect(after).toHaveStyle({ left: '75%' })
  })

  it('cuts the track at each pinned end from the very first press', () => {
    render(<MarkTrack bookmarks={[]} loop={{ a: 30, b: null }} duration={120} onSeek={vi.fn()} />)
    expect(screen.getByTestId('loop-edge')).toHaveStyle({ left: '25%' })
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

  it('a loop that cannot run cuts the track but dims nothing', () => {
    // Both ends pinned isn't enough — dimming for a loop that isn't repeating
    // would claim it is. The cuts still show, since you did pin those moments.
    for (const loop of [{ a: 30, b: 30.2 }, { a: 90, b: 30 }]) {
      const { unmount } = render(
        <MarkTrack bookmarks={[]} loop={loop} duration={120} onSeek={vi.fn()} />
      )
      expect(screen.queryAllByTestId('loop-dim')).toHaveLength(0)
      expect(screen.getAllByTestId('loop-edge')).toHaveLength(2)
      unmount()
    }
  })

  it('dims up to A when that is the only end pinned', () => {
    // A on its own repeats to the end of the video, so the bar says so: the
    // stretch from A onwards is what stays at full strength.
    render(<MarkTrack bookmarks={[]} loop={{ a: 30, b: null }} duration={120} onSeek={vi.fn()} />)
    const [before, after] = screen.getAllByTestId('loop-dim')
    expect(before).toHaveStyle({ width: '25%' })
    expect(after).toHaveStyle({ left: '100%' })  // nothing left to dim
    expect(screen.getByLabelText('Loop start (A) at 0:30')).toBeInTheDocument()
  })

  it('and from B on when that is', () => {
    render(<MarkTrack bookmarks={[]} loop={{ a: null, b: 90 }} duration={120} onSeek={vi.fn()} />)
    const [before, after] = screen.getAllByTestId('loop-dim')
    expect(before).toHaveStyle({ width: '0%' })
    expect(after).toHaveStyle({ left: '75%' })
  })

  it('dims nothing for a pinned end with nothing to repeat', () => {
    // A in the last half-second leaves no stretch to run; the notch claims only
    // that you pinned this moment.
    render(<MarkTrack bookmarks={[]} loop={{ a: 119.8, b: null }} duration={120} onSeek={vi.fn()} />)
    expect(screen.queryAllByTestId('loop-dim')).toHaveLength(0)
    expect(screen.getByTestId('loop-edge')).toBeInTheDocument()
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

  it('dims YouTube’s own bar either side of a running loop', () => {
    // The rail is all we have over there — the track being dimmed is the
    // embed's, laid under ours at the same offset.
    render(<EmbedMarkRail bookmarks={[]} loop={{ a: 30, b: 90 }} duration={120} onSeek={vi.fn()} />)
    const [before, after] = screen.getAllByTestId('loop-dim')
    expect(before).toHaveStyle({ width: '25%' })
    expect(after).toHaveStyle({ left: '75%' })
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
    render(<MarksFlash flash={{ kind: 'bookmark', text: 'Bookmarked · 1:05' }} />)
    expect(screen.getByText('Bookmarked · 1:05')).toBeInTheDocument()
  })

  it('marks which feature just spoke', () => {
    const { container, rerender } = render(<MarksFlash flash={{ kind: 'bookmark', text: 'Bookmarked · 1:05' }} />)
    expect(container.querySelector('span')).toHaveClass('bg-sky-400')
    // The loop's is the bar's own white, since that's all the loop ever wears.
    rerender(<MarksFlash flash={{ kind: 'loop', text: 'Loop cleared' }} />)
    expect(container.querySelector('span')).toHaveClass('bg-white/70')
  })
})
