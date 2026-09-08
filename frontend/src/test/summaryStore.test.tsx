import { render, screen, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startSummary, loadSummaries, useSummaryStatus, useSummarisedIds, _resetSummaries,
} from '../hooks/summaryStore'

function Harness({ id }: { id: string }) {
  const summary = useSummaryStatus(id)
  return (
    <div data-testid="status">{summary ? `${summary.status}/${summary.length}` : 'none'}</div>
  )
}

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => handler(String(input), init),
    clone: () => ({ text: async () => '' }),
  }) as unknown as Response)
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

beforeEach(() => { _resetSummaries() })
afterEach(() => { _resetSummaries(); vi.restoreAllMocks() })

describe('summaryStore', () => {
  it('has no status for a video nobody has summarised', () => {
    render(<Harness id="abc" />)
    expect(screen.getByTestId('status')).toHaveTextContent('none')
  })

  it('labels the card running before the request comes back', async () => {
    // The point of the optimistic write: the click is the moment the label
    // should appear, not the round trip.
    let release: (v: unknown) => void = () => {}
    globalThis.fetch = vi.fn(() => new Promise((r) => { release = r })) as unknown as typeof fetch
    render(<Harness id="abc" />)
    act(() => { startSummary('abc', 'short') })
    expect(screen.getByTestId('status')).toHaveTextContent('running/short')
    await act(async () => {
      release({ ok: true, status: 200, json: async () => ({ status: 'running', length: 'short' }) })
    })
  })

  it('drops the label again when the request is refused', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({}), clone: () => ({ text: async () => '' }),
    })) as unknown as typeof fetch
    render(<Harness id="abc" />)
    await act(async () => { await startSummary('abc') })
    expect(screen.getByTestId('status')).toHaveTextContent('none')
  })

  it('loads what the server already knows', async () => {
    stubFetch(() => ({ jobs: [{ video_id: 'abc', status: 'done', length: 'long' }] }))
    render(<Harness id="abc" />)
    await act(async () => { await loadSummaries() })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('done/long'))
  })

  it('keeps the last known status when the server cannot be reached', async () => {
    stubFetch(() => ({ jobs: [{ video_id: 'abc', status: 'done', length: 'long' }] }))
    render(<Harness id="abc" />)
    await act(async () => { await loadSummaries() })

    globalThis.fetch = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    await act(async () => { await loadSummaries() })
    expect(screen.getByTestId('status')).toHaveTextContent('done/long')
  })

  it('sends the length that was asked for', async () => {
    const fn = stubFetch(() => ({ status: 'running', length: 'short' }))
    render(<Harness id="abc" />)
    await act(async () => { await startSummary('abc', 'short') })
    const body = JSON.parse(String((fn.mock.calls[0][1] as RequestInit).body))
    expect(body).toEqual({ length: 'short' })
  })
})

// ── The "summarised only" filter's half of the store ─────────
//
// The same map, in the shape the sidebar's chip asks it in: which videos have
// a finished summary. Derived on write rather than per read, because
// useSyncExternalStore compares snapshots by identity and a Set built inside
// the selector would be a new object every render.

function IdHarness() {
  const ids = useSummarisedIds()
  return <div data-testid="ids">{[...ids].sort().join(',') || 'none'}</div>
}

describe('useSummarisedIds', () => {
  it('is empty before anything has been summarised', () => {
    render(<IdHarness />)
    expect(screen.getByTestId('ids')).toHaveTextContent('none')
  })

  it('holds the finished ones only', async () => {
    // A job still running has nothing to read yet and one that errored has
    // nothing at all — matching the backend's summarised_video_ids, so the
    // client-side filter and the paged one agree about the same library.
    stubFetch(() => ({ jobs: [
      { video_id: 'done1', status: 'done', length: 'long' },
      { video_id: 'busy', status: 'running', length: 'long' },
      { video_id: 'broke', status: 'error', length: 'short' },
      { video_id: 'done2', status: 'done', length: 'short' },
    ] }))
    render(<IdHarness />)
    await act(async () => { await loadSummaries() })
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('done1,done2'))
  })

  it('picks up a summary that lands while the page is open', async () => {
    stubFetch(() => ({ jobs: [{ video_id: 'abc', status: 'running', length: 'long' }] }))
    render(<IdHarness />)
    await act(async () => { await loadSummaries() })
    expect(screen.getByTestId('ids')).toHaveTextContent('none')

    stubFetch(() => ({ jobs: [{ video_id: 'abc', status: 'done', length: 'long' }] }))
    await act(async () => { await loadSummaries() })
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('abc'))
  })

  it('hands back the same set until one actually changes', async () => {
    // The identity contract useSyncExternalStore is checking: a re-render that
    // changed nothing must not look like a change, or it never stops.
    const seen: Set<string>[] = []
    function Spy() { seen.push(useSummarisedIds()); return null }
    stubFetch(() => ({ jobs: [{ video_id: 'abc', status: 'done', length: 'long' }] }))
    const { rerender } = render(<Spy />)
    await act(async () => { await loadSummaries() })
    rerender(<Spy />)
    expect(seen[seen.length - 1]).toBe(seen[seen.length - 2])
  })
})
