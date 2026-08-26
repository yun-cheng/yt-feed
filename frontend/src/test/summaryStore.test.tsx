import { render, screen, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startSummary, loadSummaries, useSummaryStatus, _resetSummaries,
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
