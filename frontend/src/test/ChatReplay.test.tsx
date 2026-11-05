import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import ChatReplay, { CHAT_WINDOW, sentBy, type ChatMessage } from '../components/ChatReplay'

type Reply = Record<string, unknown>

/** A server answering the chat endpoint from a script: one reply per request,
 *  the last repeating. Records each request's method. */
function serve(...replies: Reply[]) {
  const methods: string[] = []
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET')
    const body = replies.length > 1 ? replies.shift()! : replies[0]
    return { ok: true, status: 200, json: async () => body, clone: () => ({ text: async () => '' }) }
  }) as unknown as typeof fetch
  return methods
}

const msg = (s: number, a: string, text: string, more: Partial<ChatMessage> = {}): ChatMessage =>
  ({ t: s * 1000, a, r: [text], ...more })

const MESSAGES = [msg(5, '@ann', 'first'), msg(60, '@bo', 'second'), msg(120, '@cy', 'third')]

const onSeek = vi.fn()
async function mount(time: number, duration = 600) {
  const view = render(
    <ChatReplay videoId="vid00000001" time={time} duration={duration} onSeek={onSeek} syncButton={{ className: '', icon: '↓' }} />,
  )
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
  return view
}
const rerenderAt = (view: Awaited<ReturnType<typeof mount>>, time: number) =>
  view.rerender(<ChatReplay videoId="vid00000001" time={time} duration={600} onSeek={onSeek} syncButton={{ className: '', icon: '↓' }} />)

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); onSeek.mockReset() })

describe('sentBy', () => {
  it('counts the messages sent by a moment, that moment included', () => {
    expect(sentBy(MESSAGES, 0)).toBe(0)
    expect(sentBy(MESSAGES, 5_000)).toBe(1)
    expect(sentBy(MESSAGES, 119_999)).toBe(2)
    expect(sentBy(MESSAGES, 999_999)).toBe(3)
  })
})

describe('ChatReplay', () => {
  it('shows the chat sent up to the play head, and more as the video reaches it', async () => {
    serve({ status: 'done', messages: MESSAGES })
    const view = await mount(61)
    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
    expect(screen.queryByText('third')).not.toBeInTheDocument()

    rerenderAt(view, 121)
    expect(screen.getByText('third')).toBeInTheDocument()
  })

  it('says the chat is still ahead before its first message', async () => {
    serve({ status: 'done', messages: MESSAGES })
    await mount(1)
    expect(screen.getByText('Messages appear here as the video reaches them.')).toBeInTheDocument()
  })

  it('draws only the latest stretch of a long chat', async () => {
    const many = Array.from({ length: CHAT_WINDOW + 50 }, (_, i) => msg(i, `@u${i}`, `line ${i}`))
    serve({ status: 'done', messages: many })
    await mount(10_000)
    expect(screen.queryByText('line 49')).not.toBeInTheDocument()
    expect(screen.getByText('line 50')).toBeInTheDocument()
    expect(screen.getByText(`line ${CHAT_WINDOW + 49}`)).toBeInTheDocument()
  })

  it('starts the fetch on first opening, and says how far it has got', async () => {
    const methods = serve({ status: 'none' }, { status: 'running', covered: 90 })
    await mount(0)
    expect(methods).toEqual(['GET', 'POST'])
    expect(screen.getByText('Fetching the chat replay… 1:30 of 10:00')).toBeInTheDocument()
  })

  it('keeps asking while it runs, and shows the chat when it lands', async () => {
    serve({ status: 'running', covered: 10 }, { status: 'done', messages: MESSAGES })
    await mount(61)
    expect(screen.queryByText('first')).not.toBeInTheDocument()
    await act(async () => { vi.advanceTimersByTime(1000); for (let i = 0; i < 5; i++) await Promise.resolve() })
    expect(screen.getByText('first')).toBeInTheDocument()
  })

  it('says why a fetch failed, and tries again on asking', async () => {
    const methods = serve({ status: 'error', error: 'Sign in to confirm you’re not a bot' }, { status: 'running', covered: 0 })
    await mount(0)
    expect(screen.getByText('The chat replay couldn’t be fetched.')).toBeInTheDocument()
    expect(screen.getByText(/not a bot/)).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
    expect(methods).toEqual(['GET', 'POST'])
  })

  it('marks the channel, moderators and Super Chats, and seeks from a message’s time', async () => {
    serve({ status: 'done', messages: [
      msg(5, '@chan', 'welcome', { b: 'owner' }),
      msg(6, '@mod', 'be nice', { b: 'mod' }),
      { t: 7_000, a: '@rich', r: [], p: 'NT$150' },
      { t: 8_000, a: '@ann', r: ['gg ', { e: 'https://e/48', n: ':hype:' }] },
    ] })
    await mount(100)
    expect(screen.getByText('@chan')).toHaveClass('bg-yellow-400')
    expect(screen.getByText('@mod')).toHaveClass('text-blue-400')
    expect(screen.getByText('NT$150')).toBeInTheDocument()
    expect(screen.getByAltText(':hype:')).toHaveAttribute('src', 'https://e/48')

    fireEvent.click(screen.getByRole('button', { name: '0:06' }))
    expect(onSeek).toHaveBeenCalledWith(6)
  })

  it('holds still while you scroll up to read, until you go back to the present', async () => {
    serve({ status: 'done', messages: MESSAGES })
    const view = await mount(61)
    const box = screen.getByText('first').closest('.overflow-y-auto') as HTMLElement
    Object.defineProperty(box, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 300, configurable: true })
    box.scrollTop = 100
    fireEvent.scroll(box)

    rerenderAt(view, 121)
    expect(screen.queryByText('third')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Sync to video' }))
    expect(screen.getByText('third')).toBeInTheDocument()
  })
})
