/**
 * The removals you can take back: that the server's receipt is what goes back,
 * and that nothing is offered when there was nothing to remove.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { removeHistory, removePlaylistItem, removeImported, deleteDownload } from '../lib/undo'
import { useToasts } from '../hooks/toastStore'
import { render, screen, act, fireEvent } from '@testing-library/react'
import Toaster from '../components/Toaster'

const HISTORY_ROW = {
  youtube_id: 'v1', title: 'A video', position_seconds: 412.5,
  duration_seconds: 600, watched: true, watched_at: '2026-09-01T10:00:00',
}

function reply(body: unknown, ok = true) {
  return Promise.resolve({
    ok, status: ok ? 200 : 500, json: () => Promise.resolve(body),
    clone: () => ({ text: () => Promise.resolve('') }),
  } as unknown as Response)
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock = vi.fn(() => reply({ status: 'ok', removed: HISTORY_ROW }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  // The toast store is module-level: drain it, or one test's offer is still
  // standing in the next one.
  act(() => { vi.runAllTimers() })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** The calls made, as [method, url] pairs. */
const calls = () => fetchMock.mock.calls.map(([url, init]) => [
  (init as RequestInit | undefined)?.method ?? 'GET', String(url),
])

/** Press the Undo the last removal offered, and let the restore go out. */
async function pressUndo() {
  await act(async () => { fireEvent.click(screen.getByText('Undo')) })
}

describe('removing a history row', () => {
  it('deletes it, then offers it back', async () => {
    render(<Toaster />)
    await act(async () => { await removeHistory('v1') })
    expect(calls()).toEqual([['DELETE', '/api/history/v1']])
    expect(screen.getByText('Removed from history')).toBeInTheDocument()
  })

  it('puts back the row the server handed over, not a fresh one', async () => {
    // This is the whole point of the receipt: a restore carries the resume
    // point and the watched flag, which re-reporting progress cannot.
    render(<Toaster />)
    await act(async () => { await removeHistory('v1') })
    await pressUndo()
    const [method, url] = calls()[1]
    expect([method, url]).toEqual(['POST', '/api/history/restore'])
    const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))
    expect(body).toEqual(HISTORY_ROW)
  })

  it('refetches so the page shows the row again', async () => {
    const after = vi.fn()
    render(<Toaster />)
    await act(async () => { await removeHistory('v1', after) })
    await pressUndo()
    expect(after).toHaveBeenCalled()
  })

  it('offers nothing when there was nothing there', async () => {
    fetchMock.mockImplementation(() => reply({ status: 'ok', removed: null }))
    render(<Toaster />)
    await act(async () => { await removeHistory('v1') })
    expect(screen.queryByText('Undo')).not.toBeInTheDocument()
  })

  it('offers nothing when the delete itself failed', async () => {
    fetchMock.mockImplementation(() => reply({ detail: 'nope' }, false))
    render(<Toaster />)
    await act(async () => { await removeHistory('v1') })
    expect(screen.queryByText('Undo')).not.toBeInTheDocument()
  })
})

describe('the other three', () => {
  it('puts a playlist item back on its own list, with its place', async () => {
    const item = { youtube_id: 'v1', title: 'A video', created_at: '2026-01-01T00:00:00' }
    fetchMock.mockImplementation(() => reply({ status: 'ok', removed: item }))
    render(<Toaster />)
    await act(async () => { await removePlaylistItem(7, 'v1') })
    expect(calls()[0]).toEqual(['DELETE', '/api/playlists/7/items/v1'])
    await pressUndo()
    expect(calls()[1]).toEqual(['POST', '/api/playlists/7/items'])
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)).created_at)
      .toBe('2026-01-01T00:00:00')
  })

  it('takes an imported video back', async () => {
    fetchMock.mockImplementation(() => reply({
      status: 'ok', removed: { youtube_id: 'v1', created_at: '2026-01-01T00:00:00' },
    }))
    render(<Toaster />)
    await act(async () => { await removeImported('v1') })
    expect(calls()[0]).toEqual(['DELETE', '/api/imported/v1'])
    await pressUndo()
    expect(calls()[1]).toEqual(['POST', '/api/imported/restore'])
  })

  it('re-downloads a deleted file, since the file itself is gone', async () => {
    fetchMock.mockImplementation(() => reply({
      ok: true, removed: { youtube_id: 'v1', title: 'A video', status: 'ready' },
    }))
    render(<Toaster />)
    await act(async () => { await deleteDownload('v1') })
    expect(screen.getByText('Download deleted')).toBeInTheDocument()
    await pressUndo()
    expect(calls()[1]).toEqual(['POST', '/api/downloads'])
  })
})

describe('the toast store it pushes to', () => {
  it('holds one offer per removal', async () => {
    function Count() { return <span data-testid="n">{useToasts().length}</span> }
    render(<Count />)
    await act(async () => { await removeHistory('v1'); await removeHistory('v2') })
    expect(screen.getByTestId('n')).toHaveTextContent('2')
  })
})
