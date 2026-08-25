/**
 * The Ask panel — a streamed answer, and the promises it makes about it.
 *
 * Two things here are worth pinning above the rest. The reply arrives token by
 * token over server-sent events, so the panel has to render a HALF answer
 * correctly, including one whose frames arrive split down the middle of a line.
 * And a citation in that answer has to end up as a seek — that's the whole
 * reason the answers carry timestamps at all.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AskPanel from '../components/AskPanel'

let calls: { url: string; method: string; body?: string }[]

/** A ReadableStream of raw SSE text, handed over in the chunks given. */
function sse(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(c) {
      if (i >= chunks.length) { c.close(); return }
      c.enqueue(enc.encode(chunks[i++]))
    },
  })
}

function frame(o: Record<string, unknown>) {
  return `data: ${JSON.stringify(o)}\n\n`
}

/** `thread` answers the GET; `stream` (or `status`) answers the POST. */
function serve({ thread = [], stream, status = 200 }: {
  thread?: { role: string; content: string }[]
  stream?: string[]
  status?: number
}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url: String(input), method, body: init?.body as string | undefined })
    if (method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ messages: thread }) } as Response
    }
    if (method === 'DELETE') return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response
    return {
      ok: status === 200, status,
      body: status === 200 ? sse(stream ?? []) : null,
      json: async () => ({ detail: 'nope' }),
      clone() { return this },
      text: async () => '',
    } as unknown as Response
  }))
}

function panel(over: Partial<Parameters<typeof AskPanel>[0]> = {}) {
  return (
    <AskPanel videoId="v1" currentTime={0} onSeek={vi.fn()} fillsPane={false} {...over} />
  )
}

function ask(text = 'what about pricing?') {
  fireEvent.change(screen.getByPlaceholderText('Ask about this video'), { target: { value: text } })
  fireEvent.click(screen.getByLabelText('Send question'))
}

beforeEach(() => { calls = [] })
afterEach(() => { vi.unstubAllGlobals() })

describe('AskPanel', () => {
  it('reads the thread this video already has', async () => {
    serve({ thread: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }] })
    render(panel())

    await screen.findByText('earlier question')
    expect(screen.getByText('earlier answer')).toBeTruthy()
    expect(calls[0]).toMatchObject({ url: '/api/ask/v1', method: 'GET' })
  })

  it('offers openers while nothing has been asked', async () => {
    serve({ thread: [] })
    render(panel())
    expect(await screen.findByText('Short summary')).toBeTruthy()
    expect(screen.getByText('Long summary')).toBeTruthy()
  })

  it('the two openers ask for the lengths they are named for', async () => {
    // They used to be "Summarise this video" and "What are the key points?" —
    // the same request twice, and the same answer twice.
    serve({ thread: [], stream: [frame({ delta: 'ok' }), frame({ done: true })] })
    const { unmount } = render(panel())
    fireEvent.click(await screen.findByText('Short summary'))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    const quick = JSON.parse(calls.find((c) => c.method === 'POST')!.body!).question
    unmount()

    calls = []
    serve({ thread: [], stream: [frame({ delta: 'ok' }), frame({ done: true })] })
    render(panel())
    fireEvent.click(await screen.findByText('Long summary'))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    const full = JSON.parse(calls.find((c) => c.method === 'POST')!.body!).question

    expect(quick).toMatch(/three sentences/)
    expect(full).toMatch(/in full/)
    expect(quick).not.toBe(full)
  })

  it('drops the openers once the thread has something in it', async () => {
    serve({ thread: [{ role: 'user', content: 'earlier question' }] })
    render(panel())
    await screen.findByText('earlier question')
    expect(screen.queryByText('Long summary')).toBeNull()
  })

  it('streams the answer in, a piece at a time', async () => {
    serve({ thread: [], stream: [frame({ delta: 'It went up ' }), frame({ delta: 'in March.' }), frame({ done: true })] })
    render(panel())
    await screen.findByText('Short summary')

    ask()
    await screen.findByText('what about pricing?')
    await waitFor(() => expect(screen.getByText(/It went up in March\./)).toBeTruthy())
  })

  it('reassembles an event split across two network chunks', async () => {
    // The reader hands over whatever arrived, which need not be whole frames.
    const whole = frame({ delta: 'half a ' }) + frame({ delta: 'sentence' }) + frame({ done: true })
    const cut = Math.floor(whole.length / 3)
    serve({ thread: [], stream: [whole.slice(0, cut), whole.slice(cut)] })
    render(panel())
    await screen.findByText('Short summary')

    ask()
    await waitFor(() => expect(screen.getByText(/half a sentence/)).toBeTruthy())
  })

  it('a cited timestamp seeks the player', async () => {
    const onSeek = vi.fn()
    serve({ thread: [], stream: [frame({ delta: 'They say so at [12:34].' }), frame({ done: true })] })
    render(panel({ onSeek }))
    await screen.findByText('Short summary')

    ask()
    fireEvent.click(await screen.findByRole('button', { name: '12:34' }))
    expect(onSeek).toHaveBeenCalledWith(754)
  })

  it('sends the play head with the question, so a long video is read where you are', async () => {
    serve({ thread: [], stream: [frame({ delta: 'ok' }), frame({ done: true })] })
    render(panel({ currentTime: 612.5 }))
    await screen.findByText('Short summary')

    ask()
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.method === 'POST')!.body!))
      .toEqual({ question: 'what about pricing?', at: 612.5 })
  })

  it('an opener sends its question rather than prefilling the box', async () => {
    serve({ thread: [], stream: [frame({ delta: 'a summary' }), frame({ done: true })] })
    render(panel())

    fireEvent.click(await screen.findByText('Short summary'))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(screen.getByPlaceholderText('Ask about this video')).toHaveValue('')
  })

  it('renders the answer as Markdown, timestamps still live', async () => {
    const onSeek = vi.fn()
    serve({ thread: [], stream: [
      frame({ delta: '**S Tier**\n- Fable 5 [31:02]\n- 56 Soul [2:51]\n' }),
      frame({ done: true }),
    ] })
    render(panel({ onSeek }))
    await screen.findByText('Short summary')

    ask()
    await screen.findByText('S Tier')
    const box = screen.getByPlaceholderText('Ask about this video').closest('.flex.flex-col')!
    expect(box.querySelectorAll('ul > li')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '31:02' }))
    expect(onSeek).toHaveBeenCalledWith(1862)
  })

  it('says when only part of a long video was read', async () => {
    serve({ thread: [], stream: [
      frame({ delta: 'ok' }),
      frame({ done: true, truncated: true, covered: [600, 900] }),
    ] })
    render(panel())
    await screen.findByText('Short summary')

    ask()
    expect(await screen.findByText(/10:00–15:00/)).toBeTruthy()
  })

  it('a whole transcript makes no excuses', async () => {
    serve({ thread: [], stream: [frame({ delta: 'ok' }), frame({ done: true, truncated: false })] })
    render(panel())
    await screen.findByText('Short summary')

    ask()
    await screen.findByText('ok')
    expect(screen.queryByText(/too long to read whole/)).toBeNull()
  })

  it('a question that never reached the model goes back in the box', async () => {
    // Nothing is saved server-side before the first token, so leaving it in the
    // thread would show a turn that a reload would not.
    serve({ thread: [], status: 503 })
    render(panel())
    await screen.findByText('Short summary')

    ask()
    await screen.findByText(/didn’t get through/)
    expect(screen.queryByText('what about pricing?', { selector: 'div' })).toBeNull()
    expect(screen.getByPlaceholderText('Ask about this video')).toHaveValue('what about pricing?')
  })

  it('a video with no transcript says so in its own words', async () => {
    serve({ thread: [], status: 422 })
    render(panel())
    await screen.findByText('Short summary')

    ask()
    expect(await screen.findByText(/no transcript/)).toBeTruthy()
  })

  it('keeps an answer that stopped partway', async () => {
    serve({ thread: [], stream: [frame({ delta: 'It went up ' }), frame({ error: 'provider went away' })] })
    render(panel())
    await screen.findByText('Short summary')

    ask()
    await screen.findByText(/stopped early/)
    expect(screen.getByText(/It went up/)).toBeTruthy()
  })

  it('Enter sends and Shift+Enter does not', async () => {
    serve({ thread: [], stream: [frame({ delta: 'ok' }), frame({ done: true })] })
    render(panel())
    await screen.findByText('Short summary')

    const box = screen.getByPlaceholderText('Ask about this video')
    fireEvent.change(box, { target: { value: 'a question' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(calls.some((c) => c.method === 'POST')).toBe(false)

    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
  })

  it('clearing empties the thread and tells the server', async () => {
    serve({ thread: [{ role: 'user', content: 'earlier question' }] })
    render(panel())
    await screen.findByText('earlier question')

    fireEvent.click(screen.getByText('Clear conversation'))
    await waitFor(() => expect(screen.queryByText('earlier question')).toBeNull())
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/ask/v1')).toBe(true)
  })
})
