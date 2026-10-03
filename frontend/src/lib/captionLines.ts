/**
 * Which caption lines are up at a given moment: as the track times them, word
 * by word, or stitched into whole sentences. Shared by the captions over the
 * video and the transcript beside it.
 */
import { CJK, MAX_CJK_LINE_CHARS, MAX_LINE_CHARS } from './captionSplit'

// A timed caption cue from /feed/captions. `words` carries per-word timing (for
// auto-generated tracks) so we can reveal a line word-by-word; manual subs get a
// single word = the whole line.
export type CaptionWord = { t: number; text: string }
export type Cue = { start: number; dur: number; text: string; words?: CaptionWord[] }

// A rendered caption line: its text and whether it came from a word-by-word
// (auto) track — which drives left-alignment vs centering.
export type CaptionLine = { text: string; wordByWord: boolean }

// The caption lines to show at `curTime` for one cue list. Auto-caption cues
// overlap in time (the next line starts while the previous is still up), which
// is how YouTube's rolling 2-line effect is encoded — so we show EVERY cue
// spanning curTime, oldest first. Each cue reveals its words up to the play head
// (a hair of lookahead hides the 120ms poll lag); a cue without per-word timing
// (manual subs) shows its whole line at once. Shared by the main + second tracks.
export function linesAt(cues: Cue[] | null, curTime: number): CaptionLine[] {
  if (!cues?.length) return []
  return cues
    .filter((c) => c.start <= curTime && curTime < c.start + c.dur)
    .sort((a, b) => a.start - b.start)
    .map((c) => {
      // Reveal word-by-word only when the track carries per-word timing (auto
      // captions); manual/translated subs are one "word" = the whole cue.
      const wordByWord = !!c.words && c.words.length > 1
      const text = wordByWord
        ? c.words!.filter((w) => w.t <= curTime + 0.15).map((w) => w.text).join('').trim()
        : c.text
      return { text, wordByWord }
    })
    .filter((l) => l.text)
}

// A token whose text ends a sentence (Latin or CJK terminals, optional closing quote).
const SENTENCE_END = /[.!?。！？][")'”’」』]?\s*$/
// Where a too-long sentence may be broken; how long "too long" is lives with
// splitTimed, which breaks the lines that have no word timing to break on.
const BREAK_AFTER = /[,;:，、；：][")'”’」』]?\s*$/

/** Append one token to a running string, spacing Latin but not CJK. */
function appendToken(s: string, t: string): string {
  if (!t) return s
  if (!s) return t
  // Auto-word tokens carry their own leading space; add one only when neither
  // side already has whitespace and it isn't a CJK boundary (which needs none).
  const gap = !/\s$/.test(s) && !/^\s/.test(t) && !(CJK.test(s.slice(-1)) && CJK.test(t[0]))
  return s + (gap ? ' ' + t : t)
}

/** Join tokens [from, to) into one string, spacing Latin but not CJK. */
function joinTokens(toks: { t: number; text: string }[], from: number, to: number): string {
  let s = ''
  for (let i = from; i < to; i++) s = appendToken(s, toks[i].text)
  return s.trim()
}
// Group a cue list into whole SENTENCES for "Whole sentence" mode. Sentence ends fall
// *mid-cue* (tracks break lines at phrase boundaries, and rolling auto captions
// pack several phrases per cue), so we segment on the WORD stream, not on cues.
// Cue order is reading order and word times run sequentially even though the
// display cues overlap (the rolling 2-line effect), so flattening is safe. Each
// sentence shows until the next one begins. Memoize per cue list.
// `chunk` splits an over-long sentence into display-sized pieces — right for an
// on-video caption block, wrong for the transcript panel, which reads better as
// whole sentences and has the width to hold them.
export function toSentences(cues: Cue[] | null, chunk = true): { start: number; end: number; text: string }[] {
  if (!cues?.length) return []
  // Does this track even use sentence punctuation? Chinese ASR often has none, so
  // there's nothing to merge on — showing one line per cue (each is already a
  // short phrase) beats collapsing the whole video into one block. Latin tracks
  // split sentences across cues, so they cross this bar and get merged below.
  const punctuated = cues.reduce((n, c) => n + (/[.!?。！？]/.test(c.text) ? 1 : 0), 0) / cues.length >= 0.05
  if (!punctuated) {
    return cues
      .map((c, i) => ({ start: c.start, end: i + 1 < cues.length ? cues[i + 1].start : Number.POSITIVE_INFINITY, text: c.text.trim() }))
      .filter((s) => s.text)
  }

  const toks: { t: number; text: string }[] = []
  for (const c of cues) {
    if (c.words && c.words.length) for (const w of c.words) toks.push({ t: w.t, text: w.text })
    else toks.push({ t: c.start, text: c.text })  // manual sub = one token (whole cue)
  }

  const sents: { start: number; text: string }[] = []
  let buf: { t: number; text: string }[] = []

  const flush = () => {
    if (!buf.length) return
    // A stitched sentence can run far longer than is readable in one block, so
    // break it into display-sized pieces. Only word-segment tracks reach here with
    // real tokens, so each piece takes an exact start from its own token.
    //
    // Pieces are sized EVENLY rather than greedily filled to the cap. Greedy
    // filling breaks at the last comma before the cap, which emits a runt whenever
    // the sentence's only comma sits near the start ("She woke up," + a full line)
    // and leaves a stray few words as the tail. So: decide up front how many
    // pieces are needed, then put each break as near its ideal length as possible,
    // treating a comma as a preference (a scoring bonus) rather than a command.
    const whole = joinTokens(buf, 0, buf.length)
    if (!chunk) {
      if (whole) sents.push({ start: buf[0].t, text: whole })
      buf = []
      return
    }
    const limit = CJK.test(whole) ? MAX_CJK_LINE_CHARS : MAX_LINE_CHARS
    const pieces = Math.ceil(whole.length / limit)
    const target = whole.length / pieces

    let from = 0
    for (let p = 1; p < pieces && from < buf.length; p++) {
      let best = -1
      let bestScore = Infinity
      let s = ''
      for (let i = from; i < buf.length - 1; i++) {
        s = appendToken(s, buf[i].text)
        const len = s.trim().length
        if (len > limit) break
        // Distance from the ideal length, with a comma worth a modest discount —
        // enough to prefer a nearby comma, not enough to accept a bad one.
        const score = Math.abs(len - target) - (BREAK_AFTER.test(buf[i].text) ? target * 0.25 : 0)
        if (score < bestScore) { bestScore = score; best = i }
      }
      if (best < 0) break
      const piece = joinTokens(buf, from, best + 1)
      if (piece) sents.push({ start: buf[from].t, text: piece })
      from = best + 1
    }
    const tail = joinTokens(buf, from, buf.length)
    if (tail) sents.push({ start: buf[from].t, text: tail })
    buf = []
  }

  for (const w of toks) {
    buf.push(w)
    if (SENTENCE_END.test(w.text)) flush()
  }
  flush()  // trailing run with no terminal punctuation

  return sents.map((s, i) => ({
    start: s.start,
    end: i + 1 < sents.length ? sents[i + 1].start : Number.POSITIVE_INFINITY,
    text: s.text,
  }))
}

// The whole-sentence line(s) to show now — one centered block per active sentence.
export function sentenceLinesAt(sentences: { start: number; end: number; text: string }[], curTime: number): CaptionLine[] {
  return sentences
    .filter((s) => s.start <= curTime && curTime < s.end)
    .map((s) => ({ text: s.text, wordByWord: false }))
}
