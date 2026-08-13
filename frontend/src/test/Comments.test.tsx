/**
 * The comments panel, whose whole design is about NOT fetching.
 *
 * The first two tests are the feature's actual contract — a comment fetch takes
 * a couple of seconds of somebody's bandwidth, so it happens when asked for and
 * at no other moment. Everything after that is the panel behaving once open.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Comments from '../components/Comments'

function comment(over: Record<string, unknown> = {}) {
  return {
    id: 'c1', text: 'nice one', author: '@fan', author_id: 'UC9',
    author_thumbnail: '', author_is_uploader: false, author_is_verified: false,
    is_pinned: false, hearted: false, like_count: 0,
    timestamp: 1_700_000_000, time_text: '2 days ago', replies: [],
    ...over,
  }
}

function payload(over: Record<string, unknown> = {}) {
  return {
    disabled: false, fetched: 1, capped: false, has_replies: false,
    threads: [comment()], ...over,
  }
}

let calls: string[]

function serve(body: Record<string, unknown> | ((url: string) => Record<string, unknown>)) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    return {
      ok: true, status: 200,
      json: async () => (typeof body === 'function' ? body(url) : body),
    } as Response
  }))
}

beforeEach(() => { calls = [] })
afterEach(() => { vi.unstubAllGlobals() })

describe('Comments', () => {
  it('fetches nothing until the panel is expanded', () => {
    serve(payload())
    render(<Comments videoId="v1" onSeek={vi.fn()} />)
    expect(calls).toEqual([])
  })

  it('expanding fetches the comments, then their replies', async () => {
    serve((url) => payload({ has_replies: url.includes('replies=1') }))
    render(<Comments videoId="v1" onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    await screen.findByText('nice one')
    expect(calls[0]).toBe('/api/feed/comments/v1?sort=top')

    // The second walk follows on its own — the replies are part of the one ask,
    // not a second thing to click.
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]).toBe('/api/feed/comments/v1?sort=top&replies=1')
  })

  it('reopening reads what is already in hand', async () => {
    serve((url) => payload({ has_replies: url.includes('replies=1') }))
    render(<Comments videoId="v1" onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    await waitFor(() => expect(calls).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    await screen.findByText('nice one')
    expect(calls).toHaveLength(2)
  })

  it('skips the replies walk when there is nothing to deepen', async () => {
    serve(payload({ fetched: 0, threads: [] }))
    render(<Comments videoId="v1" onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    await screen.findByText(/no comments yet/i)
    await waitFor(() => expect(calls).toHaveLength(1))
  })

  it('keeps the comments readable when the replies walk fails', async () => {
    /* The comments are already on screen. Nothing was promised about replies,
     * so there's nothing to apologise for. */
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('replies=1')) throw new Error('offline')
      return { ok: true, status: 200, json: async () => payload() } as Response
    }))
    render(<Comments videoId="v1" onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(screen.getByText('nice one')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
  })

  it('starts closed again on a new video, without fetching', async () => {
    serve(payload())
    const { rerender } = render(<Comments videoId="v1" onSeek={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    await screen.findByText('nice one')

    rerender(<Comments videoId="v2" onSeek={vi.fn()} />)
    await waitFor(() => expect(screen.queryByText('nice one')).not.toBeInTheDocument())
    // No further calls: a remembered "open" would have fetched for this video,
    // and for every video after it.
    const settled = calls.length
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toHaveLength(settled)
  })

  it('turns a timestamp in a comment into a seek', async () => {
    const onSeek = vi.fn()
    serve(payload({ threads: [comment({ text: 'the good bit is at 1:23' })] }))
    render(<Comments videoId="v1" onSeek={onSeek} />)

    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    fireEvent.click(await screen.findByRole('button', { name: '1:23' }))
    expect(onSeek).toHaveBeenCalledWith(83)
  })

  it('says when comments are switched off rather than showing an empty list', async () => {
    serve(payload({ disabled: true, fetched: 0, threads: [] }))
    render(<Comments videoId="v1" onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    expect(await screen.findByText(/turned off/i)).toBeInTheDocument()
  })

  it('distinguishes an empty section from a switched-off one', async () => {
    serve(payload({ fetched: 0, threads: [] }))
    render(<Comments videoId="v1" onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    expect(await screen.findByText(/no comments yet/i)).toBeInTheDocument()
  })

  it('changes sort in one request, keeping the replies already paid for', async () => {
    serve((url) => payload({ has_replies: url.includes('replies=1') }))
    render(<Comments videoId="v1" onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    await waitFor(() => expect(calls).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: 'Newest' }))
    await waitFor(() => expect(calls).toHaveLength(3))
    // Having waited once for replies, switching sort must not throw them away —
    // and must not walk twice again to get them back.
    expect(calls[2]).toBe('/api/feed/comments/v1?sort=new&replies=1')
  })

  it('folds the replies in when they arrive, without opening any thread', async () => {
    serve((url) => payload({
      has_replies: url.includes('replies=1'),
      threads: [comment({ replies: url.includes('replies=1') ? [comment({ id: 'r1', text: 'agreed' })] : [] })],
    }))
    render(<Comments videoId="v1" onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    await screen.findByText('nice one')

    // The count appears on its own; the replies stay folded until asked for.
    fireEvent.click(await screen.findByRole('button', { name: /1 reply/ }))
    expect(await screen.findByText('agreed')).toBeInTheDocument()
  })

  it('nests a chain of replies, under one count and one toggle', async () => {
    /* Replies chain — A answers B answers C — and YouTube draws each level a
     * step in, so this does too. The count is every reply beneath the comment,
     * not just the direct ones: that's what "2 replies" means to someone
     * deciding whether to open it. Below the top there's no toggle of its own —
     * the thread is open, so its shape is simply shown. */
    serve(payload({
      has_replies: true,
      threads: [comment({
        text: 'the claim',
        replies: [comment({
          id: 'r1', text: 'answering the claim',
          replies: [comment({ id: 'r2', text: '@someone answering the answer' })],
        })],
      })],
    }))
    render(<Comments videoId="v1" onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    // Two replies, not "1 reply" with the second uncounted a level down.
    fireEvent.click(await screen.findByRole('button', { name: /2 replies/ }))

    const deep = await screen.findByText('answering the answer', { exact: false })
    const mid = screen.getByText('answering the claim')
    // Drawn one step further in than the reply it answers.
    expect(mid.compareDocumentPosition(deep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(deep.closest('div.border-l')).not.toBe(mid.closest('div.border-l'))
    // One toggle in the whole panel: the nested reply doesn't bring its own.
    expect(screen.queryByRole('button', { name: /1 reply/ })).not.toBeInTheDocument()
  })

  it('offers a retry when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    render(<Comments videoId="v1" onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('says a capped list is the top of the section, not all of it', async () => {
    serve(payload({ capped: true }))
    render(<Comments videoId="v1" onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    expect(await screen.findByText(/doesn't page through the rest/i)).toBeInTheDocument()
  })
})
