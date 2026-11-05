/**
 * The panel's Chat tab: a finished stream's chat, played back against the
 * video the way YouTube's own replay plays it — the messages sent up to the
 * moment you're at, newest at the bottom.
 *
 * Fetched the first time the tab opens, by the backend (routers/chat.py), which
 * keeps it: a 3-hour stream's chat is ~30 seconds of walking YouTube's pages,
 * so the tab says how far that has got rather than spinning. Every later
 * visit, by anyone, is a single read.
 *
 * Scrolled to the newest message while you watch. Scroll up to read and the
 * list holds still under you — new messages would otherwise push what you're
 * reading off the top — until you scroll back down or press the button that
 * brings it back to the present.
 *
 * Three pieces, so the same chat can be shown more than one way: the fetch
 * (`useChatReplay`, one per page, read by everything that shows the chat), the
 * list (`ChatList`, with or without times, on the panel's ground or straight on
 * the picture), and the panel's tab built from them. ChatOverlay is the other
 * way in.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { apiFetch } from '../lib/api'
import { formatTime } from '../lib/time'
import { t } from '../lib/i18n'
import { setChatNames, useChatNames } from '../hooks/chatNames'

/** A run of a message: text, or a channel's custom emoji as a picture. */
type Run = string | { e: string; n: string }
export type ChatMessage = {
  /** Milliseconds into the stream. */
  t: number
  a: string
  r: Run[]
  /** The channel itself, a moderator, or a member. */
  b?: 'owner' | 'mod' | 'member'
  /** A Super Chat's amount. */
  p?: string
  /** A new member's welcome. */
  m?: boolean
}

export type ChatState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'running'; covered: number }
  | { status: 'done'; messages: ChatMessage[] }
  | { status: 'error'; error: string }

/** How many messages are drawn at once: the ones just before the play head.
 *  A busy stream's chat runs to tens of thousands, and nobody scrolls back
 *  through more than this while watching. */
export const CHAT_WINDOW = 150

/** How close to the bottom still counts as "at the newest". */
const AT_BOTTOM_PX = 24

/** How many messages have been sent by `ms` into the stream. */
export function sentBy(messages: ChatMessage[], ms: number): number {
  let lo = 0
  let hi = messages.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (messages[mid].t <= ms) lo = mid + 1
    else hi = mid
  }
  return lo
}

const NAME_STYLE: Record<NonNullable<ChatMessage['b']> | 'none', string> = {
  // YouTube's own tells: the channel's name on yellow, moderators in blue,
  // members in green.
  owner: 'rounded bg-yellow-400 px-1 text-black',
  mod: 'text-blue-400',
  member: 'text-green-400',
  none: 'text-shade-aa',
}

function ChatLine({ m, onSeek, showTime, showName }: {
  m: ChatMessage
  onSeek: (seconds: number) => void
  showTime: boolean
  showName: boolean
}) {
  return (
    <div className={`flex gap-2 rounded-lg px-1.5 py-0.5 ${m.p ? 'bg-amber-500/15' : m.m ? 'bg-green-500/10' : ''}`}>
      {showTime && (
        <button
          onClick={() => onSeek(m.t / 1000)}
          className="shrink-0 pt-px font-mono text-(length:--panel-time) tabular-nums text-shade-99 hover:text-tint-3ea6ff"
        >
          {formatTime(m.t / 1000)}
        </button>
      )}
      <p className="min-w-0 text-(length:--panel-body) leading-snug text-shade-dd [overflow-wrap:anywhere]">
        {showName && <span className={`mr-1.5 font-medium ${NAME_STYLE[m.b ?? 'none']}`}>{m.a}</span>}
        {m.p && <span className="mr-1.5 rounded bg-amber-500/25 px-1 font-semibold text-amber-200">{m.p}</span>}
        {m.r.map((run, i) => typeof run === 'string'
          ? <span key={i}>{run}</span>
          : (
            <img
              key={i}
              src={run.e}
              alt={run.n}
              title={run.n}
              loading="lazy"
              className="inline h-[1.4em] w-[1.4em] align-text-bottom"
            />
          ))}
      </p>
    </div>
  )
}

/**
 * The chat replay of `videoId`, fetched by the backend the first time anything
 * asks for it (`wanted`), then watched until it lands. One per page: the panel's
 * tab and the overlay read the same one, so showing both fetches nothing twice.
 */
export function useChatReplay(videoId: string, wanted: boolean): { state: ChatState; retry: () => void } {
  const [state, setState] = useState<ChatState>({ status: 'idle' })
  const [attempt, setAttempt] = useState(0)
  // A new video starts over, and isn't asked about until something shows it.
  useEffect(() => { setState({ status: 'idle' }); setAttempt(0) }, [videoId])
  const started = wanted || state.status !== 'idle'

  // Asked once; started if nobody has fetched it yet; then watched until it
  // lands. A retry starts it again straight away.
  useEffect(() => {
    if (!started) return
    let stopped = false
    let timer: number | undefined
    const ask = async (start: boolean) => {
      try {
        const r = await apiFetch(`/api/chat/${videoId}`, start ? { method: 'POST', quiet: true } : { quiet: true })
        if (!r.ok) throw new Error(String(r.status))
        const d = await r.json()
        if (stopped) return
        if (d.status === 'none' && !start) return ask(true)
        setState(d.status === 'done' ? { status: 'done', messages: d.messages ?? [] }
          : d.status === 'running' ? { status: 'running', covered: d.covered ?? 0 }
          : d.status === 'error' ? { status: 'error', error: d.error ?? '' }
          : { status: 'none' })
        if (d.status === 'running') timer = window.setTimeout(() => ask(false), 1000)
      } catch {
        if (!stopped) setState({ status: 'error', error: '' })
      }
    }
    setState((s) => (s.status === 'idle' ? { status: 'loading' } : s))
    void ask(attempt > 0)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [videoId, attempt, started])  // eslint-disable-line react-hooks/exhaustive-deps

  return { state, retry: () => setAttempt((a) => a + 1) }
}

/** The chat as a list, following the play head (see the module comment). */
export function ChatList({ feed, time, duration, onSeek, syncButton, showTime = true, onPicture = false }: {
  feed: { state: ChatState; retry: () => void }
  /** The play head, in seconds. */
  time: number
  /** The video's length, for the progress line while the chat is fetched. */
  duration: number
  onSeek: (seconds: number) => void
  /** The floating "back to the present" button's look, shared with the
   *  transcript's. */
  syncButton: { className: string; icon: ReactNode }
  /** Each message's time, as a button that seeks. */
  showTime?: boolean
  /** Drawn straight on the video rather than on the panel's dark ground: the
   *  text carries its own shadow, and the scrollbar keeps out of the picture. */
  onPicture?: boolean
}) {
  const { state, retry } = feed
  const showNames = useChatNames()
  const messages = state.status === 'done' ? state.messages : null
  const liveEnd = useMemo(() => (messages ? sentBy(messages, time * 1000) : 0), [messages, time])
  // Where the list stopped when you scrolled up to read; null while it follows.
  const [heldEnd, setHeldEnd] = useState<number | null>(null)
  const end = heldEnd ?? liveEnd
  const shown = messages ? messages.slice(Math.max(0, end - CHAT_WINDOW), end) : []

  const boxRef = useRef<HTMLDivElement>(null)
  const pin = () => {
    const box = boxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }
  useLayoutEffect(() => { if (heldEnd === null) pin() }, [end, heldEnd])
  // A box that changes size — the overlay resized, the player going
  // fullscreen — keeps its newest message in view while it follows.
  const following = useRef(true)
  following.current = heldEnd === null
  useEffect(() => {
    const box = boxRef.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (following.current) pin() })
    ro.observe(box)
    return () => ro.disconnect()
  }, [])
  // Only the reader's own scrolling holds the list: a wheel, a touch, a key,
  // or the scrollbar. A scroll the layout caused (the box resized under it)
  // is not someone reading back.
  const reading = useRef(0)
  const intent = () => { reading.current = Date.now() }
  const onScroll = () => {
    const box = boxRef.current
    if (!box || !messages) return
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < AT_BOTTOM_PX
    if (atBottom) { if (heldEnd !== null) setHeldEnd(null); return }
    if (heldEnd === null && Date.now() - reading.current < 1000) setHeldEnd(liveEnd)
    else if (heldEnd === null) pin()
  }

  const note = (text: ReactNode) => (
    <p className="px-1.5 py-2 text-(length:--panel-body) leading-snug text-shade-aa">{text}</p>
  )

  return (
    <div className={`relative min-h-0 flex-1 ${onPicture ? 'chat-on-picture' : ''}`}>
      <div
        ref={boxRef}
        onScroll={onScroll}
        onWheel={intent}
        onTouchStart={intent}
        onKeyDown={intent}
        onPointerDown={intent}
        className={`h-full overflow-y-auto overscroll-contain px-1.5 pb-3 pt-1 ${onPicture ? '[scrollbar-width:none]' : ''}`}
      >
        {(state.status === 'idle' || state.status === 'loading' || state.status === 'none') && note(t('Fetching the chat replay…'))}
        {state.status === 'running' && (
          <div className="px-1.5 py-2">
            {note(t('Fetching the chat replay… {done} of {total}', {
              done: formatTime(state.covered), total: formatTime(duration),
            }))}
            <div className="mx-1.5 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-tint-3ea6ff transition-[width]"
                style={{ width: `${duration ? Math.min(100, (state.covered / duration) * 100) : 0}%` }}
              />
            </div>
          </div>
        )}
        {state.status === 'error' && (
          <div className="px-1.5 py-2 text-(length:--panel-body) leading-snug text-shade-aa">
            <p>{t('The chat replay couldn’t be fetched.')}</p>
            {state.error && <p className="mt-1 text-xs text-shade-99 [overflow-wrap:anywhere]">{state.error}</p>}
            <button
              onClick={retry}
              className="mt-2 rounded-full bg-white/10 px-3 py-1 text-sm text-white hover:bg-white/20"
            >
              {t('Try again')}
            </button>
          </div>
        )}
        {messages && !messages.length && note(t('Nobody wrote in this stream’s chat.'))}
        {messages && messages.length > 0 && !shown.length && note(t('Messages appear here as the video reaches them.'))}
        {shown.map((m, i) => <ChatLine key={`${m.t}-${end - shown.length + i}`} m={m} onSeek={onSeek} showTime={showTime} showName={showNames} />)}
      </div>
      {heldEnd !== null && (
        <button
          onClick={() => setHeldEnd(null)}
          aria-label={t('Sync to video')}
          title={t('Sync to video')}
          className={`absolute bottom-3 right-3 ${syncButton.className}`}
        >
          {syncButton.icon}
        </button>
      )}
    </div>
  )
}

/** Shows or hides who wrote each message, everywhere the chat shows (see
 *  hooks/chatNames). An icon only, with the words as its tooltip: it shares a
 *  row with Float over the video, and the panel can be narrow. */
export function ChatNamesToggle({ className }: { className: string }) {
  const shown = useChatNames()
  const text = shown ? t('Hide names') : t('Show names')
  return (
    <button onClick={() => setChatNames(!shown)} aria-label={text} title={text} className={className}>
      {/* A person, struck through while their names are hidden. */}
      <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
        <circle cx="12" cy="8" r="4" />
        <path strokeLinecap="round" d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
        {!shown && <path strokeLinecap="round" d="M3 3l18 18" />}
      </svg>
    </button>
  )
}

const HEADER_BUTTON = 'flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs text-shade-cc transition-colors hover:bg-white/10 hover:text-white'

/** The panel's Chat tab: the list with times, and a way to float it over the
 *  picture instead. */
export default function ChatReplay({ onFloat, ...list }: Parameters<typeof ChatList>[0] & { onFloat: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 justify-end gap-1 px-2 pb-1">
        <ChatNamesToggle className={HEADER_BUTTON} />
        <button onClick={onFloat} className={HEADER_BUTTON}>
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <rect x="12" y="7" width="6" height="8" rx="1" fill="currentColor" />
          </svg>
          {t('Float over the video')}
        </button>
      </div>
      <ChatList {...list} />
    </div>
  )
}
