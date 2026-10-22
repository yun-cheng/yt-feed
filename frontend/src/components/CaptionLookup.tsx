/**
 * Look up a word in a paused caption: rest the pointer on it and its
 * dictionary entry opens above (or, for captions at the top, below) it, with
 * the term itself highlighted in the line — which may be more than the word
 * under the pointer ("ice cream") or less than the run of characters around it
 * (Chinese, cut by the dictionary into its words).
 *
 * Paused only. While the video plays the lines change under the pointer and
 * a caption is something to read past, not into.
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { dictionaryUnavailable, formatDefinition, lookUp, type DictEntry, type DictSection } from '../lib/dictionary'

// How long the pointer rests on a word before its entry opens, and the
// quicker hop once one is open and you're reading along the line.
const DWELL_MS = 250
const HOP_MS = 80
// Grace for crossing from the word to its entry (or a gap in the line).
const HIDE_MS = 200

type Found = DictEntry & { key: string; text: string }

/** The caret under a point, in whichever spelling this browser has. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y)
    return p && { node: p.offsetNode, offset: p.offset }
  }
  const r = document.caretRangeFromPoint?.(x, y)
  return r && { node: r.startContainer, offset: r.startOffset }
}

function hits(node: Node, from: number, x: number, y: number): boolean {
  const r = document.createRange()
  r.setStart(node, from)
  r.setEnd(node, from + 1)
  return [...r.getClientRects()].some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)
}

/**
 * The index into `line`'s text of the character under the point, or null over
 * its padding. A caret sits BETWEEN characters, at whichever gap is nearer, so
 * the character is the one after it or the one before, whichever the point is in.
 */
function indexUnder(line: HTMLElement, x: number, y: number): number | null {
  const c = caretAt(x, y)
  if (!c || c.node.nodeType !== Node.TEXT_NODE || !line.contains(c.node)) return null
  const len = c.node.textContent?.length ?? 0
  const offset = c.offset < len && hits(c.node, c.offset, x, y) ? c.offset
    : c.offset > 0 && hits(c.node, c.offset - 1, x, y) ? c.offset - 1
    : null
  if (offset === null) return null
  // The line is split into spans around a highlighted term; count from its start.
  const before = document.createRange()
  before.setStart(line, 0)
  before.setEnd(c.node, offset)
  return before.toString().length
}

export type CaptionLookup = ReturnType<typeof useCaptionLookup>

/**
 * State for the lookup over every caption row. `key` names a line on screen
 * (its track and place); `text` is what it says, so an entry found for a line
 * that has since changed is never drawn on the new one.
 */
export function useCaptionLookup(enabled: boolean, onClickLine: () => void) {
  const [found, setFound] = useState<Found | null>(null)
  const termRef = useRef<HTMLSpanElement>(null)
  const want = useRef<{ key: string; text: string; at: number } | null>(null)
  const askTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)

  const cancelAsk = () => { want.current = null; window.clearTimeout(askTimer.current) }
  const keep = () => window.clearTimeout(hideTimer.current)
  const hideSoon = () => {
    keep()
    hideTimer.current = window.setTimeout(() => setFound(null), HIDE_MS)
  }

  useEffect(() => {
    if (enabled) return
    cancelAsk()
    keep()
    setFound(null)
  }, [enabled])
  useEffect(() => () => { cancelAsk(); keep() }, [])

  const on = enabled && !dictionaryUnavailable()

  const onMove = (key: string, text: string) => (e: MouseEvent<HTMLElement>) => {
    const at = indexUnder(e.currentTarget, e.clientX, e.clientY)
    if (at === null) { cancelAsk(); hideSoon(); return }
    keep()
    if (found && found.key === key && found.text === text && found.start <= at && at < found.start + found.length) {
      cancelAsk()
      return
    }
    const w = want.current
    if (w && w.key === key && w.text === text && w.at === at) return
    cancelAsk()
    const ask = { key, text, at }
    want.current = ask
    askTimer.current = window.setTimeout(async () => {
      const entry = await lookUp(text, at)
      if (want.current !== ask) return
      want.current = null
      setFound(entry && { ...entry, key, text })
    }, found ? HOP_MS : DWELL_MS)
  }

  /** Props for one caption line's text span. */
  const lineProps = (key: string, text: string) => on
    ? {
        onMouseMove: onMove(key, text),
        onMouseLeave: () => { cancelAsk(); hideSoon() },
        // The line now takes the pointer, so a click on it would otherwise do
        // nothing; it does what a click anywhere else on a paused video does.
        onClick: onClickLine,
        style: { pointerEvents: 'auto' as const },
      }
    : {}

  /** The line's text, its found term wrapped for the highlight. */
  const renderText = (key: string, text: string): ReactNode => {
    if (!on || !found || found.key !== key || found.text !== text) return text
    const end = found.start + found.length
    return (
      <>
        {text.slice(0, found.start)}
        <span ref={termRef} style={{ background: 'rgba(255, 255, 255, 0.28)', borderRadius: '0.15em' }}>
          {text.slice(found.start, end)}
        </span>
        {text.slice(end)}
      </>
    )
  }

  return { found: on ? found : null, termRef, lineProps, renderText, keep, hideSoon }
}

/**
 * The entry, placed against the highlighted term inside the player box: above
 * it when there's room, else below, and slid sideways to stay in the box.
 * One section per dictionary that has the term, each folding under its name
 * to a preview: its first few lines, fading out, as Look Up shows them. Every
 * word starts with them all folded; what you open is for that word.
 */
export function DictionaryTip({ lookup, box }: { lookup: CaptionLookup; box: RefObject<HTMLElement | null> }) {
  const { found, termRef, keep, hideSoon } = lookup
  const tipRef = useRef<HTMLDivElement>(null)
  // Which sections are open, and for which word. Moving to another word —
  // or back to one — folds them all again, before that word first paints.
  const [opened, setOpened] = useState<{ word: string; ids: Set<string> }>({ word: '', ids: new Set() })
  const word = found ? `${found.key}\u0000${found.text}\u0000${found.start}` : ''
  if (opened.word !== word) setOpened({ word, ids: new Set() })
  const open = opened.word === word ? opened.ids : null

  useLayoutEffect(() => {
    const place = () => {
      const tip = tipRef.current
      const term = termRef.current
      const frame = box.current
      if (!tip || !term || !frame) return
      const b = frame.getBoundingClientRect()
      const t = term.getBoundingClientRect()
      const gap = 6
      const edge = 8
      const above = t.top - b.top - gap >= tip.offsetHeight + edge
      const left = Math.min(Math.max(t.left + t.width / 2 - tip.offsetWidth / 2 - b.left, edge), b.width - tip.offsetWidth - edge)
      tip.style.left = `${Math.max(left, edge)}px`
      tip.style.top = above ? `${t.top - b.top - gap - tip.offsetHeight}px` : `${t.bottom - b.top + gap}px`
      tip.style.visibility = 'visible'
    }
    place()
    // The captions reflow with the player (a resize, fullscreen); follow them.
    const frame = box.current
    if (!frame || !found) return
    const ro = new ResizeObserver(place)
    ro.observe(frame)
    return () => ro.disconnect()
    // `open`: a section folding or unfolding changes the tip's height.
  }, [found, termRef, box, open])

  if (!found) return null
  const toggle = (dictionary: string) => {
    const ids = new Set(open)
    if (!ids.delete(dictionary)) ids.add(dictionary)
    setOpened({ word, ids })
  }
  // A lone section needs no name to tell it from the others, nor a fold.
  const lone = found.sections.length === 1
  return (
    <div
      ref={tipRef}
      role="tooltip"
      onMouseEnter={keep}
      onMouseLeave={hideSoon}
      // Placed once measured (above); hidden until then so it never flashes at 0,0.
      style={{ visibility: 'hidden', maxHeight: 'min(60%, 20rem)' }}
      className="absolute z-30 w-80 max-w-[calc(100%-1rem)] overflow-y-auto rounded-xl bg-shade-28 px-3 py-2 text-left text-[13px] leading-snug text-white shadow-lg ring-1 ring-white/10"
    >
      {found.sections.map((section, i) => {
        const shown = lone || !!open?.has(section.dictionary)
        return (
          <section key={section.dictionary || i} className={i > 0 ? 'border-t border-white/10' : ''}>
            {!lone && (
              <button
                type="button"
                aria-expanded={shown}
                onClick={() => toggle(section.dictionary)}
                // Not focusable by mouse: the player keeps the keyboard, so
                // Space still plays rather than folding this again.
                onMouseDown={(e) => e.preventDefault()}
                className="flex w-full items-center gap-1.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-shade-aa hover:text-white"
              >
                <svg className={`h-3 w-3 shrink-0 transition-transform ${shown ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                  <path d="M9 6l6 6-6 6" />
                </svg>
                <span className="truncate">{section.name}</span>
              </button>
            )}
            {shown ? <DictionarySection section={section} term={found.term} /> : (
              // The preview opens the section too: it's where the eye already is.
              <div
                onClick={() => toggle(section.dictionary)}
                onMouseDown={(e) => e.preventDefault()}
                className="max-h-[5.25rem] cursor-pointer overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"
              >
                <DictionarySection section={section} term={found.term} />
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function DictionarySection({ section, term }: { section: DictSection; term: string }) {
  const { word, reading, lines } = formatDefinition(section.definition, term)
  return (
    <div className="pb-2">
      <div className="mb-1.5">
        {/* The headword, which for "ran" is "run": the highlight in the line
            already says what was hovered. */}
        <span className="text-base font-semibold">{word || term}</span>
        {reading && <span className="ml-2 text-shade-aa">{reading}</span>}
      </div>
      {lines.map((l, i) => (
        <p
          key={i}
          className={
            l.kind === 'heading' ? 'mt-2 font-semibold italic text-shade-cc first:mt-0'
              : l.kind === 'sub' ? 'mt-1 pl-3 text-shade-cc before:-ml-3 before:inline-block before:w-3 before:content-["•"]'
                : l.kind === 'example' ? 'mt-0.5 pl-3 text-shade-aa before:-ml-3 before:inline-block before:w-3 before:content-["▸"]'
                  : 'mt-1'
          }
        >
          {/* 譯典通's grammar notes (［不可數名詞。…］) are long and repeat on
              every sense; they stay, quieter than the meaning. */}
          {l.text.split(/(［[^］]*］)/).map((part, j) => j % 2
            ? <span key={j} className="text-[11px] text-shade-88">{part}</span>
            : part)}
        </p>
      ))}
    </div>
  )
}
