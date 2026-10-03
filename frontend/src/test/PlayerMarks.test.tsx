/**
 * Bookmarks and A–B repeat: the state, the shortcuts, and the marks on the bar.
 */
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useRef } from 'react'
import {
  BookmarkMenu,
  ChapterMenu,
  NoteBox,
  MomentThumb,
  PIN_ICON,
  EmbedMarkRail,
  LoopMenu,
  MarkTrack,
  loopActive,
  loopBounds,
  usePlayerMarks,
} from '../components/PlayerMarks'
import type { Bookmark, Loop, SavedLoop } from '../components/PlayerMarks'
import type { PlayerApi } from '../components/LocalControls'
import { CHAPTER_GAP } from '../lib/chapters'
import { BOOKMARK_HEIGHT, BOOKMARK_WIDTH } from '../components/PlayerMarks'
import type { StoryboardInfo } from '../lib/storyboard'

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
  const m = usePlayerMarks(videoId, ref)
  return (
    <div>
      <div data-testid="marks">{m.bookmarks.map((b) => b.position_seconds).join(',')}</div>
      <div data-testid="notes">{m.bookmarks.map((b) => b.note).join('|')}</div>
      <div data-testid="loop">{`${m.loop.a ?? '-'}/${m.loop.b ?? '-'}`}</div>
      {/* Every passage, running one marked — the list the menu draws. */}
      <div data-testid="loops">{m.loops.map((l) => `${l.active ? '*' : ''}${l.a ?? '-'}/${l.b ?? '-'}`).join(' ')}</div>
      <div data-testid="loop-notes">{m.loops.map((l) => l.note).join('|')}</div>
      <div data-testid="others">{m.others.map((l) => `${l.a ?? '-'}/${l.b ?? '-'}`).join(' ')}</div>
      <div data-testid="stage">{m.loopStage}</div>
      <div data-testid="looping">{m.looping ? 'yes' : 'no'}</div>
      <div data-testid="here">{m.markHere ? 'yes' : 'no'}</div>
      {/* The control bar's button and the menu it opens, standing in for the
          real ones: what they get from the hook is exactly these actions. */}
      <button onClick={m.toggleBookmarkHere}>bookmark</button>
      <button onClick={() => m.setBookmarkNote(m.bookmarks[0].id, '  the reveal  ')}>note</button>
      <button onClick={() => m.pinLoopEnd('a')}>pin a</button>
      <button onClick={() => m.pinLoopEnd('b')}>pin b</button>
      <button onClick={m.newLoop}>new</button>
      <button onClick={() => m.setLoopNote(m.loops[0].id, ' chorus ')}>loop note</button>
      <button onClick={m.clearLoop}>stop</button>
      <button onClick={m.toggleRepeat}>repeat</button>
      {m.loops.map((l) => (
        <span key={l.id}>
          <button onClick={() => m.useLoop(l.id)}>{`use ${l.a ?? '-'}`}</button>
          <button onClick={() => m.dropLoop(l.id)}>{`drop ${l.a ?? '-'}`}</button>
        </span>
      ))}
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

/** Bookmark `at`, and wait for the SAVED row — id and all — to come back.
 *
 * Anything that presses `b` a second time has to go through this, because the
 * two presses mean different things depending on whether the first one's POST
 * has landed: a saved mark is deleted on the server, while one still carrying
 * its temporary negative id is only dropped from view (its own test is below —
 * "does not try to delete a mark that never reached the server").
 *
 * Waiting on `posted` doesn't tell those apart. The mock records it inside the
 * call, so it's already true before the id exists, and the test then turns on
 * whether the microtask queue happened to drain first — which under load it
 * didn't, about one run in three. */
async function markAt(p: { _set: (t: number) => void }, at: number) {
  act(() => { p._set(at) })
  await act(async () => { key('b') })
}

let posted: Array<Record<string, unknown>>
let deleted: string[]
let patched: Array<{ url: string; body: unknown }>
/** The server's saved passages, by video — many per video, at most one active. */
let loops: Record<string, SavedLoop[]>

beforeEach(() => {
  posted = []
  deleted = []
  patched = []
  loops = {}
  let nextId = 1
  let nextLoopId = 100
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(init.body as string) : null

    const one = input.match(/\/api\/bookmarks\/([^/]+)\/loops\/id\/(-?\d+)$/)
    if (one) {
      const [, video, id] = one
      const list = loops[video] ?? []
      const row = list.find((l) => l.id === Number(id))
      if (!row) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
      if (method === 'DELETE') {
        loops[video] = list.filter((l) => l !== row)
        deleted.push(input)
        return { ok: true, json: async () => ({ status: 'ok' }) } as unknown as Response
      }
      Object.assign(row, body)
      if (body?.active) for (const l of list) if (l !== row) l.active = false
      return { ok: true, json: async () => ({ ...row }) } as unknown as Response
    }

    const many = input.match(/\/api\/bookmarks\/([^/]+)\/loops$/)
    if (many) {
      const video = many[1]
      const list = loops[video] ?? (loops[video] = [])
      if (method === 'POST') {
        for (const l of list) l.active = false
        const row: SavedLoop = { id: nextLoopId++, a: body.a ?? null, b: body.b ?? null, active: true, note: body.note ?? '' }
        list.push(row)
        return { ok: true, json: async () => ({ ...row }) } as unknown as Response
      }
      return { ok: true, json: async () => list.map((l) => ({ ...l })) } as unknown as Response
    }

    if (method === 'POST') {
      posted.push(body)
      return { ok: true, json: async () => ({ id: nextId++, ...body, note: '' }) } as unknown as Response
    }
    if (method === 'DELETE') {
      deleted.push(input)
      return { ok: true, json: async () => ({ status: 'ok' }) } as unknown as Response
    }
    if (method === 'PATCH') {
      patched.push({ url: input, body })
      return { ok: true, json: async () => body } as unknown as Response
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

  it('writes a note on a bookmark, trimmed, shown at once', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    await markAt(p, 42)
    act(() => { fireEvent.click(screen.getByText('note')) })
    expect(screen.getByTestId('notes')).toHaveTextContent('the reveal')
    await waitFor(() => expect(patched).toEqual([{ url: '/api/bookmarks/id/1', body: { note: 'the reveal' } }]))
  })

  it('a note written before the bookmark is saved goes with it once it is', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(42) })
    // No await between the two: the POST is still out when the note is written.
    act(() => key('b'))
    act(() => { fireEvent.click(screen.getByText('note')) })
    await waitFor(() => expect(patched).toEqual([{ url: '/api/bookmarks/id/1', body: { note: 'the reveal' } }]))
    expect(screen.getByTestId('notes')).toHaveTextContent('the reveal')
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
    await markAt(p, 42)
    act(() => key('b'))
    expect(screen.getByTestId('marks')).toBeEmptyDOMElement()
    await waitFor(() => expect(deleted).toEqual(['/api/bookmarks/id/1']))
  })

  it('removes a mark a second or two away, since you cannot press it precisely', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    await markAt(p, 42)
    act(() => { p._set(43.5) }); act(() => key('b'))
    expect(screen.getByTestId('marks')).toBeEmptyDOMElement()
    // The DELETE as well as the disappearance: clearing a mark that never
    // reached the server empties the list too, so the list alone doesn't say
    // which of the two happened.
    await waitFor(() => expect(deleted).toEqual(['/api/bookmarks/id/1']))
  })

  it('adds rather than removes once you are clear of the tolerance', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    await markAt(p, 42)
    act(() => { p._set(50) }); act(() => key('b'))
    await waitFor(() => expect(screen.getByTestId('marks')).toHaveTextContent('42,50'))
  })

  it('removes the nearest mark when two are in range', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    // Just over the tolerance apart, so the second press adds rather than
    // removing the first — the start and end of a short phrase.
    await markAt(p, 40)
    await markAt(p, 43)
    // 41.6 is inside the tolerance of both; the 43 one is nearer.
    act(() => { p._set(41.6) }); act(() => key('b'))
    await waitFor(() => expect(screen.getByTestId('marks')).toHaveTextContent('40'))
    // And it's the 43 one the server was told about, not the 40.
    expect(deleted).toEqual(['/api/bookmarks/id/2'])
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

  it('the first press opens a passage rather than editing one', async () => {
    // So `[` on a video you have never looped behaves as it always did.
    const p = fakePlayer()
    await renderMarks(p)
    expect(screen.getByTestId('loops')).toBeEmptyDOMElement()
    act(() => { p._set(10) }); act(() => key('['))
    expect(screen.getByTestId('loops')).toHaveTextContent('*10/-')
  })

  it('and the presses after it move that one, rather than piling up', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(20) }); act(() => key(']'))
    act(() => { p._set(12) }); act(() => key('['))
    expect(screen.getByTestId('loops')).toHaveTextContent('*12/20')
  })

  it('\\ stops the repeat and keeps the passage', async () => {
    // Stopping is not deleting: the passage you marked is work, and the key
    // that turns the repeat off shouldn't throw it away.
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(20) }); act(() => key(']'))
    act(() => key('\\'))
    expect(screen.getByTestId('loop')).toHaveTextContent('-/-')
    expect(screen.getByTestId('loops')).toHaveTextContent('10/20')
  })

  it('and then [ opens a new one, since nothing is running', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    act(() => key('\\'))
    act(() => { p._set(300) }); act(() => key('['))
    expect(screen.getByTestId('loops')).toHaveTextContent('10/- *300/-')
  })


  it('each video has its own passages', async () => {
    const p = fakePlayer()
    const { rerender } = await renderMarks(p, 'vid1')
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(20) }); act(() => key(']'))
    rerender(<Harness player={p} videoId="vid2" />)
    await waitFor(() => expect(screen.getByTestId('loop')).toHaveTextContent('-/-'))
  })
})

describe('usePlayerMarks — several passages', () => {
  const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

  it('a new passage starts here and takes over', async () => {
    // One press, not "make an empty one then pin its start": there is no reason
    // to mark a passage except to start on it.
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(20) }); act(() => key(']'))
    p._set(300)
    await act(async () => { press('new') })
    expect(screen.getByTestId('loops')).toHaveTextContent('10/20 *300/-')
  })

  it('only one repeats at a time', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    p._set(300)
    await act(async () => { press('new') })
    expect(screen.getByTestId('loop')).toHaveTextContent('300/-')
    expect(screen.getByTestId('others')).toHaveTextContent('10/-')
  })

  it('switching to one seeks to the top of it', async () => {
    // You picked it to hear it; landing outside would make you wait for the
    // loop to come round before anything happened.
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    p._set(300)
    await act(async () => { press('new') })

    await act(async () => { press('use 10') })
    expect(p.seekTo).toHaveBeenCalledWith(10, true)
    expect(screen.getByTestId('loops')).toHaveTextContent('*10/- 300/-')
  })

  it('switching to one with no start pinned goes to the top of the video', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(20) }); act(() => key(']'))
    p._set(300)
    await act(async () => { press('new') })
    await act(async () => { press('use -') })
    expect(p.seekTo).toHaveBeenCalledWith(0, true)
  })

  it('dropping one leaves the rest alone', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    p._set(300)
    await act(async () => { press('new') })

    await act(async () => { press('drop 10') })
    expect(screen.getByTestId('loops')).toHaveTextContent('*300/-')
  })

  it('dropping the running one stops the repeat and promotes nothing', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    p._set(300)
    await act(async () => { press('new') })

    await act(async () => { press('drop 300') })
    expect(screen.getByTestId('loop')).toHaveTextContent('-/-')
    expect(screen.getByTestId('looping')).toHaveTextContent('no')
    expect(screen.getByTestId('loops')).toHaveTextContent('10/-')
  })

  it('the menu buttons pin the ends of whatever is running', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    p._set(10)
    await act(async () => { press('pin a') })
    p._set(20)
    await act(async () => { press('pin b') })
    expect(screen.getByTestId('loops')).toHaveTextContent('*10/20')
  })
})

describe('usePlayerMarks — one end is enough', () => {
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

  it('still asks the button for the other end', async () => {
    // Repeating and half-pinned at once is the ordinary state of a one-ended
    // loop: the badge says which end is still open.
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    expect(screen.getByTestId('stage')).toHaveTextContent('arming')
    expect(screen.getByTestId('looping')).toHaveTextContent('yes')
  })

  it('is not repeating once it is stopped', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    act(() => key('\\'))
    expect(screen.getByTestId('looping')).toHaveTextContent('no')
  })
})

describe('usePlayerMarks — passages that survive the video', () => {
  it('keep what you wrote about them', async () => {
    const p = fakePlayer()
    const { rerender } = await renderMarks(p, 'vid1')
    act(() => { p._set(10) }); act(() => key('['))
    await act(async () => {})
    act(() => { fireEvent.click(screen.getByText('loop note')) })
    expect(screen.getByTestId('loop-notes')).toHaveTextContent('chorus')
    await act(async () => {})

    rerender(<Harness player={p} videoId="vid2" />)
    await act(async () => {})
    rerender(<Harness player={p} videoId="vid1" />)
    await waitFor(() => expect(screen.getByTestId('loop-notes')).toHaveTextContent('chorus'))
    expect(loops.vid1[0].note).toBe('chorus')
  })

  it('a note written before the passage is saved goes with it once it is', async () => {
    const p = fakePlayer()
    await renderMarks(p, 'vid1')
    act(() => { p._set(10) })
    // No await between the two: the POST is still out when the note is written.
    act(() => key('['))
    act(() => { fireEvent.click(screen.getByText('loop note')) })
    await waitFor(() => expect(loops.vid1?.[0]?.note).toBe('chorus'))
  })

  it('are there again when you come back', async () => {
    // A loop is work on a passage, and the work is about the video, not about
    // the sitting that pinned it.
    const p = fakePlayer()
    const { rerender } = await renderMarks(p, 'vid1')
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(20) }); act(() => key(']'))
    await act(async () => {})

    rerender(<Harness player={p} videoId="vid2" />)
    await waitFor(() => expect(screen.getByTestId('loop')).toHaveTextContent('-/-'))
    rerender(<Harness player={p} videoId="vid1" />)
    await waitFor(() => expect(screen.getByTestId('loop')).toHaveTextContent('10/20'))
  })

  it('come back with the one you were on still running', async () => {
    const p = fakePlayer()
    const { rerender } = await renderMarks(p, 'vid1')
    act(() => { p._set(10) }); act(() => key('['))
    p._set(300)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'new' })) })
    await act(async () => {})

    rerender(<Harness player={p} videoId="vid2" />)
    await act(async () => {})
    rerender(<Harness player={p} videoId="vid1" />)
    await waitFor(() => expect(screen.getByTestId('loops')).toHaveTextContent('10/- *300/-'))
  })

  it('a stopped repeat comes back stopped, with the passage still there', async () => {
    const p = fakePlayer()
    const { rerender } = await renderMarks(p, 'vid1')
    act(() => { p._set(10) }); act(() => key('['))
    act(() => key('\\'))
    await act(async () => {})

    rerender(<Harness player={p} videoId="vid2" />)
    await act(async () => {})
    rerender(<Harness player={p} videoId="vid1" />)
    await waitFor(() => expect(screen.getByTestId('loops')).toHaveTextContent('10/-'))
    expect(screen.getByTestId('looping')).toHaveTextContent('no')
  })

  it('a deleted passage stays deleted', async () => {
    const p = fakePlayer()
    const { rerender } = await renderMarks(p, 'vid1')
    act(() => { p._set(10) }); act(() => key('['))
    await act(async () => {})
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'drop 10' })) })

    rerender(<Harness player={p} videoId="vid2" />)
    await act(async () => {})
    rerender(<Harness player={p} videoId="vid1" />)
    await act(async () => {})
    expect(screen.getByTestId('loops')).toBeEmptyDOMElement()
  })

  it('does not land on passages marked while it was in flight', async () => {
    // The fetch is a round trip and `[` is pressed the moment the passage
    // arrives; the press wins.
    const p = fakePlayer()
    loops.vid1 = [{ id: 9, a: 300, b: 330, active: true, note: '' }]
    render(<Harness player={p} videoId="vid1" />)
    act(() => { p._set(10) }); act(() => key('['))
    await act(async () => {})
    expect(screen.getByTestId('loop')).toHaveTextContent('10/-')
  })

  it('an end moved before the passage was saved still reaches the server', async () => {
    // `[` then `]` inside one round trip: the second press has no id to send
    // under, so the POST that lands carries it.
    const p = fakePlayer()
    render(<Harness player={p} videoId="vid1" />)
    await act(async () => {})
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(20) }); act(() => key(']'))
    await act(async () => {})
    await waitFor(() => expect(loops.vid1.map((l) => [l.a, l.b])).toEqual([[10, 20]]))
  })

  it('a passage dropped before it was saved does not survive on the server', async () => {
    const p = fakePlayer()
    render(<Harness player={p} videoId="vid1" />)
    await act(async () => {})
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'drop 10' })) })
    await act(async () => {})
    await waitFor(() => expect(loops.vid1).toEqual([]))
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

  it('the menu pins whichever end the keyboard left open', async () => {
    // `]` first, so the passage the buttons act on already has its end.
    const p = fakePlayer()
    p._set(30)
    await renderMarks(p)
    key(']')
    p._set(5)
    await act(async () => { press('pin a') })
    expect(screen.getByTestId('loop')).toHaveTextContent('5/30')
  })

  it('a loop too short to run stays armed, so the badge keeps asking', async () => {
    const p = fakePlayer()
    p._set(10)
    await renderMarks(p)
    await act(async () => { press('pin a') })
    p._set(10.2)  // under MIN_LOOP_SEC
    await act(async () => { press('pin b') })
    expect(screen.getByTestId('stage')).toHaveTextContent('arming')
    p._set(15)
    await act(async () => { press('pin b') })
    expect(screen.getByTestId('loop')).toHaveTextContent('10/15')
    expect(screen.getByTestId('stage')).toHaveTextContent('running')
  })


  it('the repeat button, with nothing marked, starts a passage here', async () => {
    const p = fakePlayer()
    p._set(70)
    await renderMarks(p)
    await act(async () => { press('repeat') })
    expect(screen.getByTestId('loops')).toHaveTextContent('*70/-')
  })

  it('stops the one running, and keeps it', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(20) }); act(() => key(']'))
    await act(async () => { press('repeat') })
    expect(screen.getByTestId('loops')).toHaveTextContent('10/20')
    expect(screen.getByTestId('looping')).toHaveTextContent('no')
  })

  it('and turns the newest one back on, from its top', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { p._set(10) }); act(() => key('['))
    p._set(300)
    await act(async () => { press('new') })
    await act(async () => { press('stop') })
    p._set(500)
    await act(async () => { press('repeat') })
    expect(screen.getByTestId('loops')).toHaveTextContent('10/- *300/-')
    expect(p.seekTo).toHaveBeenLastCalledWith(300, true)
  })

  it('stopping with nothing running does nothing at all', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    const calls = vi.mocked(fetch).mock.calls.length
    await act(async () => { press('stop') })
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls)
    expect(screen.getByTestId('stage')).toHaveTextContent('idle')
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

  it('still seeks back while the page re-renders faster than it ticks', async () => {
    // The watch page re-renders every 120ms while captions are on (and while a
    // panel list follows the play head). A tick restarted by every render never
    // fires, and the loop plays straight through B.
    const p = fakePlayer()
    const { rerender } = await renderMarks(p)
    setLoop(p, 10, 20)
    act(() => { p._set(20.1) })
    for (let i = 0; i < 10; i++) {
      rerender(<Harness player={p} />)
      act(() => { vi.advanceTimersByTime(100) })
    }
    expect(p.seekTo).toHaveBeenCalledWith(10, true)
  })

  it('loops back when playback carries the head into B', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    setLoop(p, 10, 20)
    act(() => { p._set(19.9) })
    act(() => { vi.advanceTimersByTime(250) })
    act(() => { p._set(20.1) })
    act(() => { vi.advanceTimersByTime(250) })
    expect(p.seekTo).toHaveBeenCalledWith(10, true)
    expect(screen.getByTestId('looping')).toHaveTextContent('yes')
  })

  it('a click past B lets go of the repeat instead, and keeps the passage', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    setLoop(p, 10, 20)
    act(() => { p._set(15) })
    act(() => { vi.advanceTimersByTime(250) })
    act(() => { p._set(90) })  // the bar, well past B
    act(() => { vi.advanceTimersByTime(250) })
    expect(p.seekTo).not.toHaveBeenCalled()
    expect(screen.getByTestId('looping')).toHaveTextContent('no')
    expect(screen.getByTestId('loops')).toHaveTextContent('10/20')
  })

  it('and so does a click before A', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    setLoop(p, 10, 20)
    act(() => { p._set(15) })
    act(() => { vi.advanceTimersByTime(250) })
    act(() => { p._set(3) })
    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.getByTestId('looping')).toHaveTextContent('no')
  })

  it('even a small step past B is a seek while paused — paused, nothing plays into it', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    setLoop(p, 10, 20)
    act(() => { p.pauseVideo() })
    act(() => { p._set(19.9) })
    act(() => { vi.advanceTimersByTime(250) })
    act(() => { p._set(20.5) })
    act(() => { vi.advanceTimersByTime(250) })
    expect(p.seekTo).not.toHaveBeenCalled()
    expect(screen.getByTestId('looping')).toHaveTextContent('no')
  })

  it('a player rebuilt under it, starting again at 0, is not a seek out', async () => {
    const p = fakePlayer()
    const ref = { current: p as PlayerApi | null }
    function Rebuilt() {
      const m = usePlayerMarks('vid1', ref)
      return <div data-testid="looping2">{m.looping ? 'yes' : 'no'}</div>
    }
    render(<Rebuilt />)
    await act(async () => {})
    act(() => { p._set(10) }); act(() => key('['))
    act(() => { p._set(20) }); act(() => key(']'))
    act(() => { p._set(15) })
    act(() => { vi.advanceTimersByTime(250) })
    const fresh = fakePlayer()  // at 0
    ref.current = fresh
    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.getByTestId('looping2')).toHaveTextContent('yes')
  })

  it('a click inside the passage keeps it repeating', async () => {
    const p = fakePlayer()
    await renderMarks(p)
    setLoop(p, 10, 20)
    act(() => { p._set(11) })
    act(() => { vi.advanceTimersByTime(250) })
    act(() => { p._set(18) })
    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.getByTestId('looping')).toHaveTextContent('yes')
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
    // Played to the end, a tick at a time — a single jump there is a seek out.
    act(() => { p._set(599.8) })
    act(() => { vi.advanceTimersByTime(250) })
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
    act(() => { key('a'); key('z'); key('k'); key(' ') })
    expect(screen.getByTestId('marks')).toBeEmptyDOMElement()
    expect(screen.getByTestId('loop')).toHaveTextContent('-/-')
  })

  it('takes a capital as the key under it', async () => {
    // Shift-B is still B: you get here by having just typed a capital, which
    // is a slip rather than a different intention.
    const p = fakePlayer()
    await renderMarks(p)
    act(() => { key('B') })
    expect(screen.getByTestId('marks')).not.toBeEmptyDOMElement()
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

describe('NoteBox', () => {
  it('starts on the note, with the cursor at its end', () => {
    render(<NoteBox label="Bookmark note" note="half" onDone={vi.fn()} />)
    const box = screen.getByLabelText('Bookmark note') as HTMLTextAreaElement
    expect(box).toHaveFocus()
    expect(box.selectionStart).toBe(4)
  })

  it('Enter keeps what was written; Shift+Enter is a new line', () => {
    const onDone = vi.fn()
    render(<NoteBox label="Bookmark note" note="" onDone={onDone} />)
    const box = screen.getByLabelText('Bookmark note')
    fireEvent.change(box, { target: { value: 'the reveal' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    // And the blur that follows doesn't answer twice.
    fireEvent.blur(box)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith('the reveal')
  })

  it('clicking away keeps it too', () => {
    const onDone = vi.fn()
    render(<NoteBox label="Bookmark note" note="" onDone={onDone} />)
    const box = screen.getByLabelText('Bookmark note')
    fireEvent.change(box, { target: { value: 'kept' } })
    fireEvent.blur(box)
    expect(onDone).toHaveBeenCalledWith('kept')
  })

  it('Escape leaves the note as it was, without reaching the player', () => {
    const onDone = vi.fn()
    render(<NoteBox label="Bookmark note" note="old" onDone={onDone} />)
    const box = screen.getByLabelText('Bookmark note')
    fireEvent.change(box, { target: { value: 'new' } })
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    fireEvent.keyDown(box, { key: 'Escape' })
    window.removeEventListener('keydown', outer)
    expect(onDone).toHaveBeenCalledWith(null)
    expect(outer).not.toHaveBeenCalled()
  })
})

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

  it('puts a bookmark’s hit area over its pin, on the same moment', () => {
    // jsdom does no layout, so this pins the classes that do the centring: both
    // sit at the moment's `left` and pull back by half their own width.
    render(<MarkTrack bookmarks={marks} loop={noLoop} duration={120} onSeek={vi.fn()} />)
    const area = screen.getByLabelText('Bookmark at 0:30')
    const pin = screen.getAllByTestId('bookmark-pin')[0]
    expect(area.style.left).toBe(pin.style.left)
    expect(area).toHaveClass('-translate-x-1/2')
    expect(pin).toHaveClass('-translate-x-1/2')
  })

  it('a bookmark with a note says it on hover', () => {
    render(<MarkTrack bookmarks={[{ id: 1, position_seconds: 30, note: 'the reveal' }]} loop={noLoop} duration={120} onSeek={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveAttribute('title', 'the reveal — jump to 0:30')
  })

  it('draws a bookmark as PotPlayer does: a pin twice a chapter cut wide, centred on the track', () => {
    // Against the track rather than inside the taller hit area, so it centres
    // on the track.
    const { container } = render(
      <div className="relative"><MarkTrack bookmarks={marks} loop={noLoop} duration={120} onSeek={vi.fn()} /></div>
    )
    const pin = screen.getAllByTestId('bookmark-pin')[0]
    expect(pin.parentElement).toBe(container.firstElementChild)
    expect(pin).toHaveClass('top-1/2', '-translate-y-1/2', 'text-white', 'z-10')
    expect(BOOKMARK_WIDTH).toBe(CHAPTER_GAP * 2)
    expect(pin.getAttribute('width')).toBe(`${BOOKMARK_WIDTH}`)
    expect(pin.style.left).toBe('25%')
  })

  it('adds no colour to the bar: the pin and the loop markers are white', () => {
    // As PotPlayer draws them. The shapes say "yours"; adding a colour to the
    // player's red and white is what makes a bar look drawn on.
    render(<MarkTrack bookmarks={marks} loop={{ a: 60, b: 90 }} duration={120} onSeek={vi.fn()} />)
    expect(screen.getAllByTestId('bookmark-pin')[0]).toHaveClass('text-white')
    expect(screen.getByTestId('loop-mark-a')).toHaveClass('text-white')
    expect(screen.getByTestId('loop-mark-b')).toHaveClass('text-white')
  })

  it('brackets a passage as PotPlayer does: ▶ at A, ◀ at B, pointing in at it', () => {
    // Each stands with its flat side on its moment and its point in the
    // passage: A runs right from A, B is pulled back its own width from B.
    render(<MarkTrack bookmarks={[]} loop={{ a: 30, b: 90 }} duration={120} onSeek={vi.fn()} />)
    const a = screen.getByTestId('loop-mark-a')
    const b = screen.getByTestId('loop-mark-b')
    expect(a).toHaveStyle({ left: '25%' })
    expect(a).not.toHaveClass('-translate-x-full')
    expect(a.querySelector('path')?.getAttribute('d')).toBe('M0 0l6 6-6 6z')
    expect(b).toHaveStyle({ left: '75%' })
    expect(b).toHaveClass('-translate-x-full')
    expect(b.querySelector('path')?.getAttribute('d')).toBe('M6 0 0 6l6 6z')
  })

  it('centres them on the track, as tall as a bookmark pin and above the play head', () => {
    render(<MarkTrack bookmarks={[]} loop={{ a: 30, b: 90 }} duration={120} onSeek={vi.fn()} />)
    const a = screen.getByTestId('loop-mark-a')
    expect(a).toHaveClass('top-1/2', '-translate-y-1/2', 'z-10')
    expect(a.getAttribute('height')).toBe(`${BOOKMARK_HEIGHT}`)
  })

  it('leaves the bar itself alone — no veil, no cuts', () => {
    // PotPlayer marks the passage and nothing else; the fill and the chapter
    // cuts read the same with a loop running as without.
    const { container } = render(
      <MarkTrack bookmarks={[]} loop={{ a: 30, b: 90 }} duration={120} onSeek={vi.fn()} />
    )
    expect(container.querySelectorAll('svg')).toHaveLength(2)
    expect(container.querySelectorAll('div')).toHaveLength(0)
  })

  it('marks a pinned end from the very first press', () => {
    render(<MarkTrack bookmarks={[]} loop={{ a: 30, b: null }} duration={120} onSeek={vi.fn()} />)
    expect(screen.getByTestId('loop-mark-a')).toHaveStyle({ left: '25%' })
    expect(screen.queryByTestId('loop-mark-b')).toBeNull()
  })

  it('marks a loop that cannot run all the same — you did pin those moments', () => {
    for (const loop of [{ a: 30, b: 30.2 }, { a: 90, b: 30 }]) {
      const { unmount } = render(<MarkTrack bookmarks={[]} loop={loop} duration={120} onSeek={vi.fn()} />)
      expect(screen.getByTestId('loop-mark-a')).toBeInTheDocument()
      expect(screen.getByTestId('loop-mark-b')).toBeInTheDocument()
      unmount()
    }
  })

  it('draws the other passages the same way, faint', () => {
    render(
      <MarkTrack bookmarks={[]} loop={{ a: 30, b: 60 }} others={[{ a: 90, b: 108 }]}
        duration={120} onSeek={vi.fn()} />
    )
    const idle = screen.getAllByTestId('loop-mark-idle')
    expect(idle.map((e) => e.style.left)).toEqual(['75%', '90%'])
    for (const el of idle) expect(el).toHaveClass('opacity-40')
    expect(screen.getByTestId('loop-mark-a')).not.toHaveClass('opacity-40')
  })

  it('the other passages take no clicks', () => {
    // Switching passages is the menu's job, and every hit area here is a pixel
    // of YouTube's own scrubber taken.
    render(
      <MarkTrack bookmarks={[]} loop={{ a: null, b: null }} others={[{ a: 90, b: 100 }]}
        duration={120} onSeek={vi.fn()} />
    )
    expect(screen.queryAllByRole('button')).toHaveLength(0)
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

  it('brackets a running loop over YouTube’s own bar', () => {
    render(<EmbedMarkRail bookmarks={[]} loop={{ a: 30, b: 90 }} duration={120} onSeek={vi.fn()} />)
    expect(screen.getByTestId('loop-mark-a')).toHaveStyle({ left: '25%' })
    expect(screen.getByTestId('loop-mark-b')).toHaveStyle({ left: '75%' })
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


// ── MomentThumb ──────────────────────────────────────────────────────

const SB: StoryboardInfo = {
  rows: 5, cols: 5, frame_width: 160, frame_height: 90,
  fragment_urls: ['https://sb/0.jpg', 'https://sb/1.jpg'], fragment_duration: 250,
}

describe('MomentThumb', () => {
  it('shows the frame grabbed from the file', () => {
    render(<MomentThumb time={30} width={80} frame="blob:x" storyboard={SB} />)
    const img = screen.getByTestId('moment-thumb')
    expect(img).toHaveAttribute('src', 'blob:x')
    expect(img.style.width).toBe('80px')
    expect(img.style.height).toBe('45px')
  })

  it('else the storyboard tile for that moment, at the width asked', () => {
    // 10s a tile: 30s is the fourth tile of the first sheet, at half size.
    render(<MomentThumb time={30} width={80} storyboard={SB} />)
    const tile = screen.getByTestId('moment-thumb')
    expect(tile.style.backgroundImage).toContain('https://sb/0.jpg')
    expect(tile.style.backgroundPosition).toBe('-240px 0px')
    expect(tile.style.backgroundSize).toBe('400px 225px')
    expect(tile.style.width).toBe('80px')
  })

  it('else the mark it wears on the bar, on a dark tile', () => {
    render(<MomentThumb time={30} width={80}>{PIN_ICON}</MomentThumb>)
    const box = screen.getByTestId('moment-thumb')
    expect(box.querySelector('path')?.getAttribute('d')).toMatch(/^M1\.5 0h5/)
  })
})

// ── LoopMenu ─────────────────────────────────────────────────────────

describe('LoopMenu', () => {
  const passages: SavedLoop[] = [
    { id: 1, a: 30, b: 60, active: false, note: '' },
    { id: 2, a: 90, b: null, active: true, note: '' },
  ]
  const open = (over: Partial<Parameters<typeof LoopMenu>[0]> = {}) => {
    const props = {
      loops: passages, duration: 120, stage: 'arming' as const, tapped: true,
      onPin: vi.fn(), onUse: vi.fn(), onDrop: vi.fn(),
      onStop: vi.fn(), onNew: vi.fn(), onClose: vi.fn(),
      ...over,
    }
    render(<LoopMenu {...props} />)
    return props
  }

  it('lists every passage, saying what each one repeats', () => {
    open()
    expect(screen.getByText('0:30 – 1:00')).toBeInTheDocument()
    // An unpinned end says what it resolves to, because that's what it does.
    expect(screen.getByText('1:30 – end')).toBeInTheDocument()
  })

  it('a passage with no note says what is there, dimmer', () => {
    open({ textAt: (at) => (at === 30 ? 'what was said' : '') })
    expect(screen.getByText('what was said')).toHaveClass('text-white/45')
  })

  it('a passage says what it is, under its range', () => {
    open({ loops: [{ id: 1, a: 30, b: 60, active: false, note: 'the run in bar 12' }], onNote: vi.fn() })
    expect(screen.getByText('the run in bar 12')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit note' })).toBeInTheDocument()
  })

  it('its pencil writes a note in place, kept on Enter', () => {
    const onNote = vi.fn()
    const onWriting = vi.fn()
    const props = open({ onNote, onWriting })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a note' })[0])
    expect(onWriting).toHaveBeenLastCalledWith(true)
    const box = screen.getByLabelText('Passage note')
    expect(box).toHaveFocus()
    // Written on, the row doesn't repeat the passage on a click.
    expect(box.closest('button')).toBeNull()
    fireEvent.change(box, { target: { value: 'chorus' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onNote).toHaveBeenCalledWith(1, 'chorus')
    expect(onWriting).toHaveBeenLastCalledWith(false)
    expect(screen.queryByLabelText('Passage note')).toBeNull()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('Escape leaves the note and keeps the menu open', () => {
    const onNote = vi.fn()
    const props = open({ onNote })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a note' })[0])
    const box = screen.getByLabelText('Passage note')
    fireEvent.change(box, { target: { value: 'chorus' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onNote).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('a press outside keeps the note before the menu closes', () => {
    const onNote = vi.fn()
    const props = open({ onNote })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a note' })[0])
    fireEvent.change(screen.getByLabelText('Passage note'), { target: { value: 'chorus' } })
    fireEvent.mouseDown(document.body)
    expect(onNote).toHaveBeenCalledWith(1, 'chorus')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('offers no pencil where nothing would keep the note', () => {
    open()
    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull()
  })

  it('picking one switches to it, and gets out of the way', () => {
    // Once you've picked a passage you want to hear it, and the panel sits over
    // the video.
    const props = open()
    fireEvent.click(screen.getByText('0:30 – 1:00'))
    expect(props.onUse).toHaveBeenCalledWith(1)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('but managing the list leaves it open', () => {
    // Pinning, deleting and stopping are all things you may do twice in a row.
    const props = open()
    fireEvent.click(screen.getByLabelText('Delete passage 0:30 – 1:00'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Pin start/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Stop repeating/ }))
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('draws each passage with the picture at its start', () => {
    // The top of the video for one whose A is open.
    const frameAt = vi.fn((t: number) => (t === 30 ? 'blob:a' : undefined))
    open({ storyboard: SB, frameAt })
    const thumbs = screen.getAllByTestId('moment-thumb')
    expect(thumbs[0]).toHaveAttribute('src', 'blob:a')
    expect(thumbs[1].style.backgroundImage).toContain(SB.fragment_urls[0])
    expect(frameAt).toHaveBeenCalledWith(90)
  })

  it('picking the one already running stops it instead', () => {
    // The row is a toggle, so the passage you're on has somewhere to go.
    const props = open()
    fireEvent.click(screen.getByText('1:30 – end'))
    expect(props.onStop).toHaveBeenCalled()
    expect(props.onUse).not.toHaveBeenCalled()
  })

  it('× deletes, and is not the same button as the row', () => {
    const props = open()
    fireEvent.click(screen.getByLabelText('Delete passage 0:30 – 1:00'))
    expect(props.onDrop).toHaveBeenCalledWith(1)
    expect(props.onUse).not.toHaveBeenCalled()
  })

  it('says which passages are marked but not repeating', () => {
    // The bar can't show a loop that isn't running, so the menu says it.
    open({ loops: [{ id: 3, a: 90, b: 30, active: false, note: '' }] })
    expect(screen.getByText('not looping')).toBeInTheDocument()
  })

  it('pins either end at the play head', () => {
    const props = open()
    fireEvent.click(screen.getByRole('menuitem', { name: /Pin start/ }))
    expect(props.onPin).toHaveBeenCalledWith('a')
    fireEvent.click(screen.getByRole('menuitem', { name: /Pin end/ }))
    expect(props.onPin).toHaveBeenCalledWith('b')
  })

  it('marks a new passage from where you are', () => {
    const props = open()
    fireEvent.click(screen.getByRole('menuitem', { name: /New passage/ }))
    expect(props.onNew).toHaveBeenCalled()
  })

  it('offers to stop only while something is pinned', () => {
    const props = open()
    fireEvent.click(screen.getByRole('menuitem', { name: /Stop repeating/ }))
    expect(props.onStop).toHaveBeenCalled()
  })

  it('and not when nothing is', () => {
    open({ stage: 'idle', loops: [] })
    expect(screen.queryByRole('menuitem', { name: /Stop repeating/ })).toBeNull()
    expect(screen.getByText('Nothing marked yet.')).toBeInTheDocument()
  })

  it('and only when a tap opened it: with a mouse, the button stops it', () => {
    open({ tapped: false })
    expect(screen.queryByRole('menuitem', { name: /Stop repeating/ })).toBeNull()
  })

  it('closes on Escape', () => {
    const props = open()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalled()
  })

  it('closes on a click outside, and stays open on one inside', () => {
    const props = open()
    fireEvent.mouseDown(screen.getByText('0:30 – 1:00'))
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.body)
    expect(props.onClose).toHaveBeenCalled()
  })
})

describe('ChapterMenu', () => {
  const rows = [
    { start: 0, text: 'Opening' },
    { start: 70, text: 'Middle' },
    { start: 140, text: 'Close' },
  ]
  const open = (active = 1) => {
    const props = { rows, active, onSeek: vi.fn(), onClose: vi.fn() }
    render(<ChapterMenu {...props} />)
    return props
  }

  it('lists the chapters, lights the playing one, and jumps without closing', () => {
    const props = open()
    expect(screen.getByRole('menuitem', { name: /Middle/ })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('menuitem', { name: /Opening/ })).not.toHaveAttribute('aria-current')
    fireEvent.click(screen.getByRole('menuitem', { name: /Close/ }))
    expect(props.onSeek).toHaveBeenCalledWith(140)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape and on a press outside', () => {
    const props = open()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(document.body)
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })
})

describe('BookmarkMenu', () => {
  const rows = [
    { id: 1, start: 30, text: 'what was said', note: '' },
    { id: 2, start: 95, text: '', note: '' },
  ]
  const open = (over: Partial<Parameters<typeof BookmarkMenu>[0]> = {}) => {
    const props = {
      rows, markHere: false,
      onSeek: vi.fn(), onRemove: vi.fn(), onToggleHere: vi.fn(), onClose: vi.fn(),
      ...over,
    }
    render(<BookmarkMenu {...props} />)
    return props
  }

  it('lists every bookmark with its line, and jumps to one without closing', () => {
    const props = open()
    expect(screen.getByText('what was said')).toBeInTheDocument()
    fireEvent.click(screen.getByText('1:35'))
    expect(props.onSeek).toHaveBeenCalledWith(95)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('a note reads brighter than the line found there', () => {
    open({ rows: [{ id: 1, start: 30, text: 'the reveal', note: 'the reveal' }, rows[0]] })
    expect(screen.getByText('the reveal')).toHaveClass('text-white/70')
    expect(screen.getByText('what was said')).toHaveClass('text-white/45')
  })

  it('its pencil writes a note in place, kept on Enter, the menu left open', () => {
    const onNote = vi.fn()
    const onWriting = vi.fn()
    const props = open({ onNote, onWriting })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a note' })[0])
    expect(onWriting).toHaveBeenLastCalledWith(true)
    const box = screen.getByLabelText('Bookmark note')
    expect(box).toHaveFocus()
    expect(box.closest('button')).toBeNull()
    fireEvent.change(box, { target: { value: 'the reveal' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onNote).toHaveBeenCalledWith(1, 'the reveal')
    expect(onWriting).toHaveBeenLastCalledWith(false)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('a press outside keeps the note before the menu closes', () => {
    const onNote = vi.fn()
    const props = open({ onNote })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a note' })[0])
    fireEvent.change(screen.getByLabelText('Bookmark note'), { target: { value: 'kept' } })
    fireEvent.mouseDown(document.body)
    expect(onNote).toHaveBeenCalledWith(1, 'kept')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('draws each row with its picture', () => {
    render(<BookmarkMenu rows={[{ ...rows[0], frame: 'blob:one' }, rows[1]]} storyboard={SB} markHere={false} onSeek={vi.fn()} onRemove={vi.fn()} onClose={vi.fn()} />)
    const thumbs = screen.getAllByTestId('moment-thumb')
    expect(thumbs).toHaveLength(2)
    // A frame grabbed from the file beats the storyboard's tile.
    expect(thumbs[0]).toHaveAttribute('src', 'blob:one')
    expect(thumbs[1].style.backgroundImage).toContain(SB.fragment_urls[0])
  })

  it('clears one from its ×', () => {
    const props = open()
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove bookmark' })[0])
    expect(props.onRemove).toHaveBeenCalledWith(1)
  })

  it('its foot does what the button does, and says which', () => {
    const props = open()
    fireEvent.click(screen.getByRole('menuitem', { name: /Bookmark this moment/ }))
    expect(props.onToggleHere).toHaveBeenCalled()
    cleanup()
    open({ markHere: true })
    expect(screen.getByRole('menuitem', { name: /Clear this bookmark/ })).toBeInTheDocument()
  })

  it('has no foot without onToggleHere, as when a hover opened it', () => {
    open({ onToggleHere: undefined })
    expect(screen.queryByRole('menuitem', { name: /Bookmark this moment/ })).not.toBeInTheDocument()
  })

  it('says so when there are none', () => {
    open({ rows: [] })
    expect(screen.getByText('Nothing marked yet.')).toBeInTheDocument()
  })

  it('a press on its own button is not a press outside', () => {
    // Hover opened it, so the pointer is on the button; pressing that shouldn't
    // shut the menu under it.
    const within = { current: document.createElement('div') }
    document.body.appendChild(within.current)
    const props = open({ within })
    fireEvent.mouseDown(within.current)
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.body)
    expect(props.onClose).toHaveBeenCalled()
    within.current.remove()
  })
})
