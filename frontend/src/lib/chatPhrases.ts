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
 * What nobody sends on its own is still caught when it suddenly runs through
 * the chat: `許哥` in `許哥好開心`, `許哥高興` and `許哥牛逼`, or `內戰` when that's
 * the talk (spikes, below). Its row is everyone who mentioned it, so `許哥 ×59`
 * can show above the `許哥牛逼 ×33` it includes.
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

/** What makes a spike: this many people within the window, this share of the
 *  chat at the time, and this many times their usual share of it. */
export const SPIKE_PEOPLE = 5
const SPIKE_SHARE = 0.05
const SPIKE_TIMES = 4
/** The longest a spike is, in words. */
const SPIKE_WORDS = 6
/** How often the same word may sit beside a spike before it's a piece of
 *  something longer. */
const SPIKE_CUT = 0.6
/** How much of a spike a longer row must take up for the spike to add nothing:
 *  no `許哥` beside a `許哥牛逼` that nearly everyone is saying. */
const SPIKE_COVERED = 0.8
/** How many of a spike's messages must hold another for them to be one. */
const SPIKE_TOGETHER = 0.6

const SEP = '\u0001'
const SPACELESS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}'
/** A number, with its sign and joints (`-1`, `3:0`, `13.1`), so that a vote
 *  for -1 isn't one for 1; one character of a language without spaces; a word;
 *  or any other single mark. */
const WORD = new RegExp(`[-+]?\\d+(?:[.:/-]\\d+)*|[${SPACELESS}]|(?:(?![${SPACELESS}])[\\p{L}\\p{M}\\d])+|\\S`, 'gu')
const HAS_MEANING = /[\p{L}\p{N}\p{Extended_Pictographic}]/u
/** A word a spike can be made of, and one that can be a spike by itself: a
 *  character of a language without spaces is too much a part of anything. */
const TALK = /^[\p{L}\p{M}\p{N}]+$/u
const SPACED = new RegExp(`[${SPACELESS}]`, 'u')
const LONE = new RegExp(`^(?:(?![${SPACELESS}])[\\p{L}\\p{M}\\p{N}]){2,}$`, 'u')

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
/** Whether the phrase `long` has the phrase `short` in it, word for word. */
const holds = (long: string, short: string) => `${SEP}${long}${SEP}`.includes(`${SEP}${short}${SEP}`)
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

/** A row with no message of its own to name it: the words as most people
 *  typed them, so `Shy` rather than `shy`. */
function phrased({ key, said }: Draft): ChatMessage {
  const plain = key.split(SEP).reduce((all, w) => all + (all && !SPACED.test(all.slice(-1)) && !SPACED.test(w) ? ' ' : '') + w, '')
  const forms = new Map<string, number>()
  for (const { m } of said) {
    for (const run of m.r) {
      if (typeof run !== 'string') continue
      const text = run.normalize('NFKC')
      const at = text.toLowerCase().indexOf(plain)
      if (at < 0) continue
      const form = text.slice(at, at + plain.length)
      forms.set(form, (forms.get(form) ?? 0) + 1)
    }
  }
  const most = [...forms].reduce<[string, number]>((a, b) => (b[1] > a[1] ? b : a), [plain, 0])
  return { ...said[0].m, r: [most[0]] }
}

/** Whether `key`, in the messages `said`, is cut out of something longer: the
 *  same word keeps coming before it or after it, as 惡 does before `意收購`. */
function isCut(key: string, said: Said[]): boolean {
  const words = key.split(SEP)
  const before = new Map<string, number>()
  const after = new Map<string, number>()
  for (const s of said) {
    const at = s.words.findIndex((_, i) => words.every((w, j) => s.words[i + j] === w))
    const next = s.words[at + words.length]
    if (at > 0) before.set(s.words[at - 1], (before.get(s.words[at - 1]) ?? 0) + 1)
    if (next !== undefined) after.set(next, (after.get(next) ?? 0) + 1)
  }
  return Math.max(0, ...before.values(), ...after.values()) >= SPIKE_CUT * said.length
}

/** The stretches of `heard` when words suddenly ran through the chat, whether
 *  or not anyone sent them on their own. `drafts`, the phrases already found,
 *  take in those that are them, and those they account for go. */
function spikes(heard: Said[], drafts: Draft[]): Draft[] {
  const saying = new Map<string, Said[]>()
  for (const s of heard) {
    const seen = new Set<string>()
    for (let i = 0; i < s.words.length; i++) {
      for (let n = 1; n <= SPIKE_WORDS && i + n <= s.words.length; n++) {
        if (!TALK.test(s.words[i + n - 1])) break
        if (n === 1 && !LONE.test(s.words[i])) continue
        const key = s.words.slice(i, i + n).join(SEP)
        if (seen.has(key)) continue
        seen.add(key)
        const list = saying.get(key)
        if (list) list.push(s)
        else saying.set(key, [s])
      }
    }
  }

  // Out of its usual share of the chat, and a good part of it.
  const sent = heard.map((s) => s.t)
  const window = PHRASE_WINDOW_SEC * 1000
  const quiet = PHRASE_QUIET_SEC * 1000
  const found: Draft[] = []
  for (const [key, said] of saying) {
    if (said.length < SPIKE_PEOPLE) continue
    const usual = said.length / heard.length
    const spans: { start: number; from: number; to: number }[] = []
    for (const { t, since, people } of crowds(said)) {
      const share = people / Math.max(1, upTo(sent, t) - upTo(sent, t - window))
      if (people < SPIKE_PEOPLE || share < SPIKE_SHARE || share < SPIKE_TIMES * usual) continue
      const last = spans[spans.length - 1]
      if (last && since - last.to <= quiet) last.to = t
      else spans.push({ start: since, from: t, to: t })
    }
    for (const { start, from, to } of spans) {
      const inSpan = said.filter((s) => start <= s.t && s.t <= to + quiet)
      if (!isCut(key, inSpan)) found.push({ key, said: inSpan, from, merged: false })
    }
  }

  // The shortest way of saying it is the one that counts everybody.
  const whole = found
    .filter((a) => !found.some((b) => b.key !== a.key && holds(a.key, b.key) && during(a, b)))
    .sort((a, b) => people(b.said) - people(a.said))

  // Two that mostly come in one message are one thing, said in many ways:
  // `今年不一樣`, `今年真的不一樣`, `今年不一樣了`. It's named as most said it.
  for (const a of whole) {
    if (a.merged) continue
    for (const b of whole) {
      if (b === a || b.merged || !during(a, b)) continue
      const both = b.said.filter((s) => holds(s.words.join(SEP), a.key))
      if (both.length < SPIKE_TOGETHER * b.said.length) continue
      const forms = new Map<string, number>()
      for (const s of both) forms.set(s.words.join(SEP), (forms.get(s.words.join(SEP)) ?? 0) + 1)
      a.key = [...forms].reduce((x, y) => (y[1] > x[1] || (y[1] === x[1] && y[0].length < x[0].length) ? y : x))[0]
      a.said = together(a.said, b.said)
      a.from = Math.min(a.from, b.from)
      b.merged = true
    }
  }

  const out: Draft[] = []
  for (const spike of whole) {
    if (spike.merged) continue
    const around = drafts.filter((d) => !d.merged && during(d, spike))
    const same = around.filter((d) => d.key === spike.key)
    if (same.length) {
      const [first, ...rest] = same
      first.said = together(first.said, ...rest.map((d) => d.said), spike.said)
      first.from = Math.min(first.from, ...rest.map((d) => d.from))
      for (const d of rest) d.merged = true
      continue
    }
    const n = people(spike.said)
    const accounted = around.some((d) => (holds(d.key, spike.key) && people(d.said) >= SPIKE_COVERED * n)
      || (holds(spike.key, d.key) && people(d.said) >= n))
    if (!accounted) out.push(spike)
  }
  return out
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
  drafts.push(...spikes(heard, drafts))

  const runs: PhraseRun[] = []
  for (const d of drafts) {
    if (d.merged) continue
    const seen = new Set<string>()
    const times: number[] = []
    // Those that say the phrase itself and nothing more, which name it best.
    const own = new Map<string, { n: number; m: ChatMessage }>()
    for (const { t, m, words } of d.said) {
      if (words.join(SEP) === d.key) {
        const form = own.get(shownAs(m))
        if (form) form.n++
        else own.set(shownAs(m), { n: 1, m })
      }
      if (seen.has(m.a)) continue
      seen.add(m.a)
      times.push(t)
    }
    const shown = own.size ? [...own.values()].reduce((a, b) => (b.n > a.n ? b : a)).m : phrased(d)
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
