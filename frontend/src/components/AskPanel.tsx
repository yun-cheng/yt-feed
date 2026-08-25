/**
 * Ask — a conversation about the video you're watching.
 *
 * The answers are grounded in the video's own transcript (see backend
 * `routers/ask.py`), which is what makes this different from asking a chatbot
 * about the subject: it can say "that isn't in this video", and it cites the
 * moment it read. Answers are Markdown — a summary of a long video is a list of
 * sections, and a wall of prose is the wrong shape for one — rendered by
 * `lib/markdown`, whose leaves go through the same `linkify` the description and
 * comments use. So a citation inside a bullet is still a button that seeks the
 * player: one behaviour for every timestamp on the page.
 *
 * Lives in the right-hand panel beside the transcript, one tab each. Mounted
 * only while that tab is open, which is what keeps it free until asked for —
 * the same bargain Comments.tsx makes.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { formatTime } from '../lib/time'

type Msg = { role: 'user' | 'assistant'; content: string }

type Props = {
  videoId: string
  /** Where the player is — sent with each question so a video too long to fit
   *  in one prompt is read around the part being watched. */
  currentTime: number
  onSeek: (seconds: number) => void
  /** Whether the panel is filling a fixed-height pane (pinned + wide), in which
   *  case the thread scrolls inside it instead of the page growing. */
  fillsPane: boolean
}

/**
 * What a fresh panel offers, so the first press needs no typing.
 *
 * Named for **how much comes back**, because that is the only way they differ
 * and the only thing worth choosing between. It's also what decides the wait —
 * the whole cost of an answer is how much of it there is to write — but the wait
 * is a consequence, not the choice, so the labels don't mention it.
 *
 * The label is short; the question sent is explicit, because length is the
 * question's to set (see the prompt in `routers/ask.py`) and a request that
 * doesn't say how much it wants gets whatever the model felt like.
 */
const OPENERS: { label: string; ask: string }[] = [
  { label: 'Short summary', ask: 'Summarise this video in about three sentences.' },
  {
    label: 'Long summary',
    ask: 'Summarise this video in full: walk through it in order and account for '
      + 'every section and every item it covers, naming each one.',
  },
]

export default function AskPanel({ videoId, currentTime, onSeek, fillsPane }: Props) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [draft, setDraft] = useState('')
  // The answer being written, separate from `messages` so a half-arrived reply
  // is never mistaken for a finished turn — including by the "ask again" guard.
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  // Set when the model was given only part of a very long transcript. Worth
  // saying: an answer read from 20 minutes of a 3-hour video is a different
  // claim from one read off the whole thing.
  const [covered, setCovered] = useState<[number, number] | null>(null)
  const [loaded, setLoaded] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  // The live position, read at send time. A ref rather than a dep so a question
  // typed over ten seconds of playback doesn't rebuild `send` ten times.
  const atRef = useRef(currentTime)
  atRef.current = currentTime

  // The thread this video already has. Cheap, and it means a conversation
  // survives a reload — and is still there when you come back to the video.
  useEffect(() => {
    let cancelled = false
    setMessages([]); setPending(null); setError(''); setCovered(null); setLoaded(false)
    apiFetch(`/api/ask/${videoId}`, { quiet: true })
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d) => {
        if (cancelled) return
        setMessages(Array.isArray(d?.messages) ? d.messages : [])
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [videoId])

  // Follow the answer as it's written, unless the reader has scrolled up to
  // re-read something — then leave them where they are.
  useEffect(() => {
    const box = scrollRef.current
    if (box && atBottom.current) box.scrollTop = box.scrollHeight
  }, [messages, pending])

  const onScroll = () => {
    const box = scrollRef.current
    if (!box) return
    atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  }

  const send = useCallback(async (question: string) => {
    const q = question.trim()
    if (!q || pending !== null) return
    setError('')
    setCovered(null)
    setDraft('')
    setMessages((m) => [...m, { role: 'user', content: q }])
    setPending('')
    atBottom.current = true

    let answer = ''
    try {
      const res = await apiFetch(`/api/ask/${videoId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, at: atRef.current }),
        // 422 is "this video has no transcript", which the panel says in its own
        // words below; the toast would repeat it in the corner.
        quietStatuses: [422],
      })
      if (!res.ok || !res.body) {
        // Nothing was saved server-side before the first token, so the question
        // goes back in the box rather than sitting in a thread that doesn't
        // have it. Retrying is then one press.
        setMessages((m) => m.slice(0, -1))
        setDraft(q)
        setError(res.status === 422
          ? "This video has no transcript, so there's nothing to read."
          : 'That question didn’t get through. Try again.')
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // Server-sent events are separated by a blank line; the tail of the
        // buffer is a frame that hasn't finished arriving.
        const frames = buf.split('\n\n')
        buf = frames.pop() ?? ''
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            let payload: { delta?: string; error?: string; done?: boolean; covered?: [number, number]; truncated?: boolean }
            try { payload = JSON.parse(line.slice(5)) } catch { continue }
            if (payload.delta) {
              answer += payload.delta
              setPending(answer)
            }
            if (payload.error) setError('The answer stopped early.')
            if (payload.done && payload.truncated && payload.covered) setCovered(payload.covered)
          }
        }
      }
    } catch {
      setError('The answer stopped early.')
    } finally {
      // Whatever arrived is kept — the server saved the same partial, so the
      // panel and a reload agree about what was said.
      if (answer) setMessages((m) => [...m, { role: 'assistant', content: answer }])
      setPending(null)
    }
  }, [videoId, pending])

  const clear = async () => {
    await apiFetch(`/api/ask/${videoId}`, { method: 'DELETE' })
    setMessages([]); setError(''); setCovered(null)
  }

  const busy = pending !== null
  const empty = loaded && !messages.length && !busy

  return (
    <div className={`flex flex-col ${fillsPane ? 'lg:min-h-0 lg:flex-1' : ''}`}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={`flex-1 space-y-3 overflow-y-auto rounded-xl bg-[#1a1a1a] p-3 ${
          fillsPane ? 'lg:h-full lg:max-h-none' : 'max-h-[26rem] lg:max-h-[34rem]'
        }`}
      >
        {empty && (
          <div className="flex flex-wrap gap-1.5 py-1">
            {OPENERS.map((o) => (
              <button
                key={o.label}
                onClick={() => send(o.ask)}
                className="rounded-full bg-[#272727] px-3 py-1.5 text-xs text-[#ddd] transition-colors hover:bg-white/15 hover:text-white"
              >
                {o.label}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            className={m.role === 'user'
              ? 'ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-[#272727] px-3 py-2 text-sm text-white [overflow-wrap:anywhere]'
              : 'text-sm leading-relaxed text-[#ccc] [overflow-wrap:anywhere]'}
          >
            {m.role === 'assistant' ? renderMarkdown(m.content, onSeek) : m.content}
          </div>
        ))}

        {busy && (
          <div className="text-sm leading-relaxed text-[#ccc] [overflow-wrap:anywhere]">
            {pending ? renderMarkdown(pending, onSeek) : <span className="text-[#888]">Reading the transcript…</span>}
          </div>
        )}

        {covered && (
          <p className="text-xs text-[#888]">
            This video is too long to read whole — the answer covers{' '}
            {formatTime(covered[0])}–{formatTime(covered[1])}.
          </p>
        )}
        {error && <p className="text-xs text-[#f28b82]">{error}</p>}
      </div>

      <div className="mt-2 flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter writes a second line. Escape gives the
            // keyboard back to the player, like the transcript's search does.
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft) }
            if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.blur() }
          }}
          rows={1}
          placeholder="Ask about this video"
          className="max-h-28 min-h-[2.25rem] flex-1 resize-none rounded-2xl bg-[#121212] px-3 py-2 text-sm text-white ring-1 ring-white/10 placeholder:text-[#888] focus:outline-none focus:ring-white/25"
        />
        <button
          onClick={() => void send(draft)}
          disabled={busy || !draft.trim()}
          aria-label="Send question"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#3ea6ff] text-black transition-colors hover:bg-[#65b8ff] disabled:bg-[#272727] disabled:text-[#666]"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>

      {!!messages.length && !busy && (
        <button
          onClick={clear}
          className="mt-1.5 self-start px-1 text-xs text-[#888] transition-colors hover:text-white"
        >
          Clear conversation
        </button>
      )}
    </div>
  )
}
