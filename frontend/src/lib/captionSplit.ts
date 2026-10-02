/**
 * Breaking a long caption into display-sized pieces when it has no per-word
 * timing — an AI-translated sentence, which arrives with only its own start and
 * end. A word-timed track is broken on its tokens instead (see toSentences in
 * WatchPage), where each piece gets the exact time of its first word.
 *
 * Here the times are a guess: each piece gets the share of the sentence's span
 * that its share of the characters is. A translation reorders clauses, so no
 * piece maps to a stretch of the source anyway; what matters is that a long
 * sentence reads a line at a time instead of standing as one tall block.
 */

export const CJK = /[　-鿿＀-￯]/
// Roughly two subtitle lines' worth: the Latin convention is ~42 characters a
// line, and CJK is far denser so it caps lower.
export const MAX_LINE_CHARS = 84
export const MAX_CJK_LINE_CHARS = 36

// A break is preferred after these…
const BREAK_AFTER = /[,;:.!?，、；：。！？]/
// …a piece may not start with these (closing marks belong to what they close)…
const NO_START = /[,.;:!?)\]，。、；：！？）」』”’]/
// …nor end on an opening mark.
const NO_END = /[(\[（「『“‘]/

export type TimedLine = { start: number; end: number; text: string }

// Where words begin, so a break never lands inside one: Chinese writes no spaces,
// and 時候 cut after 時 reads as a typo. Every position counts where the runtime
// has no segmenter.
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null
function wordStarts(text: string): (i: number) => boolean {
  if (!segmenter) return () => true
  const starts = new Set<number>()
  for (const seg of segmenter.segment(text)) starts.add(seg.index)
  return (i) => starts.has(i)
}

/** `line` cut into pieces of at most the line limit for its script, sized
 *  evenly, each timed by its share of the characters. A line that fits, or has
 *  no finite end to share out, comes back whole. */
export function splitTimed(line: TimedLine): TimedLine[] {
  const text = line.text.trim()
  const limit = CJK.test(text) ? MAX_CJK_LINE_CHARS : MAX_LINE_CHARS
  if (text.length <= limit || !Number.isFinite(line.end) || !(line.end > line.start)) return [{ ...line, text }]

  // Sized EVENLY rather than greedily filled to the cap, which leaves a runt of
  // a few characters as the tail: decide up front how many pieces are needed,
  // then put each break as near its ideal length as possible, a punctuation
  // mark being a preference rather than a command.
  const pieces = Math.ceil(text.length / limit)
  const target = text.length / pieces
  const at = (i: number) => line.start + ((line.end - line.start) * i) / text.length
  const wordStart = wordStarts(text)

  const out: TimedLine[] = []
  let from = 0
  for (let p = 1; p < pieces; p++) {
    let best = -1
    let bestScore = Infinity
    // A break after index i: at a word boundary, beside a CJK character or a
    // space — never inside a word.
    for (let i = from; i < text.length - 1; i++) {
      const len = text.slice(from, i + 1).trim().length
      if (len > limit) break
      const a = text[i]
      const b = text[i + 1]
      const between = CJK.test(a) || CJK.test(b) || /\s/.test(a) || /\s/.test(b)
      if (!between || !wordStart(i + 1) || NO_START.test(b) || NO_END.test(a) || !len) continue
      const score = Math.abs(len - target) - (BREAK_AFTER.test(a) ? target * 0.25 : 0)
      if (score < bestScore) { bestScore = score; best = i }
    }
    if (best < 0) break
    out.push({ start: at(from), end: at(best + 1), text: text.slice(from, best + 1).trim() })
    from = best + 1
  }
  const tail = text.slice(from).trim()
  if (tail) out.push({ start: at(from), end: line.end, text: tail })
  return out
}
