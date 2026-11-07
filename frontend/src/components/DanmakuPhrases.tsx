/**
 * What the chat is saying together, counted at the picture's right while the
 * 彈幕 flies: the votes when a streamer asks for a or b, the chant when a play
 * sets everyone off (lib/chatPhrases works out which, and how many).
 *
 * It reads the play head a few times a second rather than every frame: a count
 * needs no more, and it redraws only when something on it has changed. A row
 * grows with its count, the number pops each time it goes up, and a row that
 * overtakes another slides past it.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { ChatMessage } from './ChatReplay'
import type { PlayerApi } from './LocalControls'
import { PHRASE_QUIET_SEC, phraseRuns, phraseScale, phrasesAt, type PhraseRow } from '../lib/chatPhrases'
import { danmakuFont } from '../lib/danmaku'

const TICK_MS = 250
/** A row fades over this long before it's due to go. */
const FADE_MS = 1000
/** How long a row takes to slide to its new place. */
const SLIDE_MS = 250

type Row = PhraseRow & { leaving: boolean }

const sameRows = (a: Row[], b: Row[]) =>
  a.length === b.length && a.every((r, i) => r.run === b[i].run && r.count === b[i].count && r.leaving === b[i].leaving)

export default function DanmakuPhrases({ player, messages, size, style }: {
  player: RefObject<PlayerApi | null>
  messages: ChatMessage[]
  /** The 彈幕's size. Its opacity is left out: a count is there to be read,
   *  with the 彈幕 flying under it. */
  size: number
  /** Where it sits beyond its defaults, as the 彈幕's layer does. */
  style?: CSSProperties
}) {
  const runs = useMemo(() => phraseRuns(messages), [messages])
  const [rows, setRows] = useState<Row[]>([])
  const boxRef = useRef<HTMLDivElement>(null)
  // Where each row was last drawn, in the order it was.
  const topsRef = useRef(new Map<number, number>())

  useEffect(() => {
    const read = () => {
      const p = player.current
      if (!p) return
      const ms = p.getCurrentTime() * 1000
      const next = phrasesAt(runs, ms).map((row) => ({
        ...row,
        leaving: ms > row.run.last + PHRASE_QUIET_SEC * 1000 - FADE_MS,
      }))
      setRows((was) => (sameRows(was, next) ? was : next))
    }
    read()
    const id = setInterval(read, TICK_MS)
    return () => clearInterval(id)
  }, [player, runs])

  // Rows that changed places slide there from where they were. Only then: a
  // row growing with its count moves those under it, and that needs no slide.
  useLayoutEffect(() => {
    const els = [...(boxRef.current?.children ?? [])] as HTMLElement[]
    const tops = new Map(rows.map((row, i) => [row.run.id, els[i].getBoundingClientRect().top]))
    const before = [...topsRef.current.keys()].filter((id) => tops.has(id))
    const after = [...tops.keys()].filter((id) => topsRef.current.has(id))
    const swapped = before.some((id, i) => id !== after[i])
    if (swapped && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      rows.forEach((row, i) => {
        const from = topsRef.current.get(row.run.id)
        if (from === undefined || from === tops.get(row.run.id)) return
        els[i].animate?.(
          [{ transform: `translateY(${from - tops.get(row.run.id)!}px)` }, { transform: 'none' }],
          { duration: SLIDE_MS, easing: 'ease-out' },
        )
      })
    }
    topsRef.current = tops
  }, [rows])

  if (!rows.length) return null
  return (
    <div
      ref={boxRef}
      aria-hidden
      data-testid="danmaku-phrases"
      className="danmaku-phrases pointer-events-none absolute inset-x-0 top-0 z-[5]"
      style={{ fontSize: danmakuFont(size), ...style }}
    >
      {rows.map(({ run, count, leaving }) => (
        <div key={run.id} className={`danmaku-phrase${leaving ? ' is-leaving' : ''}`} style={{ fontSize: `${phraseScale(count)}em` }}>
          <span className="danmaku-phrase-text">
            {run.shown.r.map((part, i) => (typeof part === 'string' ? part : <img key={i} src={part.e} alt={part.n} draggable={false} />))}
          </span>
          {/* A new element for each count, which is what starts its pop again. */}
          <span key={count} className="danmaku-phrase-count">×{count}</span>
        </div>
      ))}
    </div>
  )
}
