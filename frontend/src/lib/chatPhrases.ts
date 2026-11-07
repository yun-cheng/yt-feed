/**
 * What the chat is saying together: when a streamer asks for a or b, or a play
 * sets everyone off, the same few words arrive from many people at once. The
 * 彈幕 scatters them across the picture; this adds them up, for `DanmakuPhrases`
 * to show at the side.
 *
 * A phrase starts as something people send on its own, so 了 and 的 don't count
 * however often they're typed. A longer message then counts for a phrase it
 * holds, so `i choose a` is a vote for `a`, and a row shows once
 * PHRASE_MIN_PEOPLE different people have said it within PHRASE_WINDOW_SEC.
 *
 * It's debounced: a phrase goes on for as long as someone says it within
 * PHRASE_QUIET_SEC of the last, its count only rising, and leaves when that
 * time has passed with nobody saying it.
 *
 * All of it is worked out once from the whole chat, so what's showing depends
 * only on the play head: a seek lands on what was showing at that moment.
 */
import type { ChatMessage } from '../components/ChatReplay'
import { isBot } from './danmaku'

export const PHRASE_WINDOW_SEC = 15
export const PHRASE_MIN_PEOPLE = 5
export const PHRASE_QUIET_SEC = 10
/** How many people must send a phrase of two words or more on its own for it
 *  to be looked for in longer messages, which then count towards
 *  PHRASE_MIN_PEOPLE: `9哥` from 3 people, and `9哥加油` and `又靠9哥` from the rest.
 *  A single word takes the full number: it's too easily part of anything. */
export const PHRASE_SEED_PEOPLE = 3
/** The most phrases shown at once: the ones most people are saying. */
export const PHRASE_ROWS = 5
/** How big a phrase is drawn at its most, against one that has just caught on,
 *  and how many people it takes to get there. */
const MAX_SCALE = 1.8
const MAX_SCALE_PEOPLE = 100
/** A phrase's size for `count` people, by the logarithm: 13 people show plainly
 *  against 5, and 200 don't fill the picture. */
export function phraseScale(count: number): number {
  const reach = Math.log(count / PHRASE_MIN_PEOPLE) / Math.log(MAX_SCALE_PEOPLE / PHRASE_MIN_PEOPLE)
  const scale = 1 + (MAX_SCALE - 1) * Math.min(1, Math.max(0, reach))
  return Math.round(scale * 100) / 100
}

/** The longest phrase, in words (a character, for the languages written
 *  without spaces): past this it's a sentence. */
const MAX_WORDS = 12
/** How many words a message may have besides a phrase and still count for it:
 *  `i choose a`, but not a sentence that happens to have an `a` in it. */
const EXTRA_WORDS = 5

const SEP = '\u0001'
const SPACELESS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}'
/** A number, with its sign and joints (`-1`, `3:0`, `13.1`), so that a vote
 *  for -1 isn't one for 1; one character of a language without spaces; a word;
 *  or any other single mark. */
const WORD = new RegExp(`[-+]?\\d+(?:[.:/-]\\d+)*|[${SPACELESS}]|(?:(?![${SPACELESS}])[\\p{L}\\p{M}\\d])+|\\S`, 'gu')
const HAS_MEANING = /[\p{L}\p{N}\p{Extended_Pictographic}]/u
/** A message's words, so that everything said the same way reads the same:
 *  `A!`, `a` and `a a a`; `777` and `77777`; `？？` and `?`; `哈哈哈` and `哈`. */
export function phraseWords(m: Pick<ChatMessage, 'r'>): string[] {
  let words: string[] = []
  for (const run of m.r) {
    if (typeof run !== 'string') { words.push(run.n); continue }
    const said = run.normalize('NFKC').toLowerCase().match(WORD) ?? []
    for (const w of said) words.push(w.replace(/(.)\1{2,}/gu, '$1$1'))
  }
  // Marks matter only when they're all there is: `-_-`, `?`.
  if (words.some((w) => HAS_MEANING.test(w))) words = words.filter((w) => HAS_MEANING.test(w))
  words = words.filter((w, i) => w !== words[i - 1])
  // The same thing over and over, as `許哥牛逼許哥牛逼` is.
  for (let n = 1; n <= words.length / 2; n++) {
    if (words.every((w, i) => w === words[i % n])) return words.slice(0, n)
  }
  return words
}

/** What a message looks like, to choose the one that shows for a phrase. */
const shownAs = (m: ChatMessage) => m.r.map((run) => (typeof run === 'string' ? run : run.n)).join('').trim()

type Said = { t: number; m: ChatMessage; words: string[] }

/** Each stretch of `said` with no gap past PHRASE_QUIET_SEC in it. */
function stretches(said: Said[]): Said[][] {
  const out: Said[][] = []
  for (const s of said) {
    const now = out[out.length - 1]
    if (now && s.t - now[now.length - 1].t <= PHRASE_QUIET_SEC * 1000) now.push(s)
    else out.push([s])
  }
  return out
}

/** At each of `said`, how many people said it within the window before, and
 *  when the first of them did. */
function* crowds(said: Said[]) {
  const within = new Map<string, number>()
  let from = 0
  for (const s of said) {
    within.set(s.m.a, (within.get(s.m.a) ?? 0) + 1)
    for (; s.t - said[from].t > PHRASE_WINDOW_SEC * 1000; from++) {
      const a = said[from].m.a
      const left = within.get(a)! - 1
      if (left) within.set(a, left)
      else within.delete(a)
    }
    yield { t: s.t, since: said[from].t, people: within.size }
  }
}

/** When a stretch first has `need` people within the window, or null if it
 *  never does. */
function caughtOn(said: Said[], need: number): number | null {
  for (const { t, people } of crowds(said)) if (people >= need) return t
  return null
}

/** Those stretches of `said` that caught on. */
function caught(said: Said[], need = PHRASE_MIN_PEOPLE): { said: Said[]; from: number }[] {
  const out: { said: Said[]; from: number }[] = []
  for (const s of stretches(said)) {
    const from = caughtOn(s, need)
    if (from !== null) out.push({ said: s, from })
  }
  return out
}

const people = (said: Said[]) => new Set(said.map((s) => s.m.a)).size

/** A phrase while it's going, in ms into the stream. */
export type PhraseRun = {
  id: number
  /** A message that says it the way most people did. */
  shown: ChatMessage
  /** When it shows from. */
  from: number
  /** When it was last said. */
  last: number
  /** When each person first said it, in order: its count at any moment. */
  times: number[]
}

type Draft = { key: string; said: Said[]; from: number; merged: boolean }

const during = (a: Draft, b: Draft) => a.said[0].t <= b.said[b.said.length - 1].t && b.said[0].t <= a.said[a.said.length - 1].t
const together = (...lists: Said[][]) => [...new Set(lists.flat())].sort((a, b) => a.t - b.t)

/** A shorter phrase takes in the longer ones around it, which are ways of
 *  saying it: `同意` takes `同意了`, `a` takes `i choose a`. But it's only a
 *  fragment of those that outweigh it, and they're left as what's being said,
 *  when it's a fragment of two (`牛逼` in `許哥牛逼` and `9哥牛逼`), or one word
 *  (`哥`, as `哥哥` reads, in `9哥`). */
function merge(drafts: Draft[]) {
  const byKey = new Map<string, Draft[]>()
  for (const d of drafts) byKey.set(d.key, [...(byKey.get(d.key) ?? []), d])

  const within = new Map<Draft, Draft[]>()
  for (const d of drafts) {
    const words = d.key.split(SEP)
    for (let n = 1; n < words.length; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        for (const short of byKey.get(words.slice(i, i + n).join(SEP)) ?? []) {
          if (!during(short, d)) continue
          const held = within.get(short)
          if (!held) within.set(short, [d])
          else if (!held.includes(d)) held.push(d)
        }
      }
    }
  }
  const longestFirst = (a: Draft, b: Draft) => b.key.split(SEP).length - a.key.split(SEP).length
  for (const short of [...drafts].sort(longestFirst)) {
    const longer = within.get(short)?.filter((d) => !d.merged)
    if (!longer) continue
    const mine = people(short.said)
    const bigger = longer.filter((d) => people(d.said) > mine)
    const fragment = bigger.length > 1 || !short.key.includes(SEP)
    const taken = fragment ? longer.filter((d) => !bigger.includes(d)) : longer
    for (const d of taken) {
      d.merged = true
      short.said = together(short.said, d.said)
      short.from = Math.min(short.from, d.from)
    }
  }
}

/** Everything the chat said together, in the order it caught on. */
export function phraseRuns(messages: ChatMessage[]): PhraseRun[] {
  const heard: Said[] = []
  const alone = new Map<string, Said[]>()
  for (const m of messages) {
    if (isBot(m.a)) continue
    const words = phraseWords(m)
    if (!words.length || words.length > MAX_WORDS + EXTRA_WORDS) continue
    const s = { t: m.t, m, words }
    heard.push(s)
    if (words.length > MAX_WORDS) continue
    const key = words.join(SEP)
    const list = alone.get(key)
    if (list) list.push(s)
    else alone.set(key, [s])
  }

  // What's caught on, sent on its own, and when.
  const hot = new Map<string, { from: number; to: number }[]>()
  for (const [key, said] of alone) {
    const need = key.includes(SEP) ? PHRASE_SEED_PEOPLE : PHRASE_MIN_PEOPLE
    const spans = caught(said, need).map((c) => ({ from: c.said[0].t, to: c.said[c.said.length - 1].t }))
    if (spans.length) hot.set(key, spans)
  }

  // Each message counts once: for the longest phrase it holds at the time.
  const quiet = PHRASE_QUIET_SEC * 1000
  const counted = new Map<string, Said[]>()
  for (const s of heard) {
    const { words } = s
    find: for (let n = Math.min(words.length, MAX_WORDS); n > 0 && words.length - n <= EXTRA_WORDS; n--) {
      for (let i = 0; i + n <= words.length; i++) {
        const key = words.slice(i, i + n).join(SEP)
        if (!hot.get(key)?.some((h) => h.from - quiet <= s.t && s.t <= h.to + quiet)) continue
        const list = counted.get(key)
        if (list) list.push(s)
        else counted.set(key, [s])
        break find
      }
    }
  }

  const drafts: Draft[] = []
  for (const [key, said] of counted) {
    for (const c of caught(said)) drafts.push({ key, ...c, merged: false })
  }
  merge(drafts)

  const runs: PhraseRun[] = []
  for (const d of drafts) {
    if (d.merged) continue
    const seen = new Set<string>()
    const times: number[] = []
    const forms = new Map<string, { n: number; m: ChatMessage }>()
    // Those that say the phrase itself and nothing more, which name it best.
    const own = new Map<string, { n: number; m: ChatMessage }>()
    for (const { t, m, words } of d.said) {
      for (const list of words.join(SEP) === d.key ? [forms, own] : [forms]) {
        const form = list.get(shownAs(m))
        if (form) form.n++
        else list.set(shownAs(m), { n: 1, m })
      }
      if (seen.has(m.a)) continue
      seen.add(m.a)
      times.push(t)
    }
    const shown = [...(own.size ? own : forms).values()].reduce((a, b) => (b.n > a.n ? b : a)).m
    runs.push({ id: 0, shown, from: d.from, last: d.said[d.said.length - 1].t, times })
  }
  runs.sort((a, b) => a.from - b.from)
  runs.forEach((run, i) => { run.id = i })
  return runs
}

/** How many of sorted `times` are at or before `ms`. */
function upTo(times: number[], ms: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= ms) lo = mid + 1
    else hi = mid
  }
  return lo
}

export type PhraseRow = { run: PhraseRun; count: number }

/** The row more people are on first; level, the one that got there first, so
 *  two neck and neck don't swap back and forth, and a seek lands on the order
 *  that was showing. */
const ahead = (a: PhraseRow, b: PhraseRow) =>
  b.count - a.count || a.run.times[a.count - 1] - b.run.times[b.count - 1] || a.run.id - b.run.id

/** What's showing at `ms`: the PHRASE_ROWS most people are saying, biggest
 *  first. */
export function phrasesAt(runs: PhraseRun[], ms: number): PhraseRow[] {
  const quiet = PHRASE_QUIET_SEC * 1000
  return runs
    .filter((run) => run.from <= ms && ms <= run.last + quiet)
    .map((run) => ({ run, count: upTo(run.times, ms) }))
    .sort(ahead)
    .slice(0, PHRASE_ROWS)
}
