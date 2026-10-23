/**
 * Dictionary entries for words in a paused caption, from the Mac's own
 * Dictionary via /api/dictionary — the backend's docstring has how.
 *
 * The server is handed the whole line and the index under the pointer, and
 * says which term that is: so the page doesn't split words to look them up,
 * and a multi-word term or an unspaced Chinese line comes back already cut.
 * Only a word the server has nothing for is cut here (`wordAt`).
 *
 * Like Look Up, the term comes with a section from each dictionary that has
 * it, in the order the Dictionary app has them.
 */
import { apiFetch } from './api'

export type DictSection = { dictionary: string; name: string; definition: string }
export type DictEntry = { term: string; start: number; length: number; sections: DictSection[] }

// What each line has answered so far: the terms found in it, and the indexes
// that turned out to be no term. Pointer moves within an answered term, or back
// onto one, need no request.
type Seen = { entries: DictEntry[]; misses: Set<number> }
const seen = new Map<string, Seen>()
const MAX_LINES = 200

// A server without a dictionary (anything but a Mac) answers 503 once; after
// that the page stops asking for the rest of the visit.
let unavailable = false

export function dictionaryUnavailable(): boolean {
  return unavailable
}

/** The entry for the term at `at` (a UTF-16 index, as JS counts) of `text`. */
export async function lookUp(text: string, at: number): Promise<DictEntry | null> {
  if (unavailable) return null
  let s = seen.get(text)
  const hit = s?.entries.find((e) => e.start <= at && at < e.start + e.length)
  if (hit) return hit
  if (s?.misses.has(at)) return null
  const res = await apiFetch(`/api/dictionary?text=${encodeURIComponent(text)}&at=${at}`, { quiet: true })
  if (res.status === 503) unavailable = true
  if (!res.ok) return null
  const entry = (await res.json()) as DictEntry | null
  if (!s) {
    if (seen.size >= MAX_LINES) seen.clear()
    s = { entries: [], misses: new Set() }
    seen.set(text, s)
  }
  if (entry) s.entries.push(entry)
  else s.misses.add(at)
  return entry
}

/**
 * The word at `at` as the browser cuts it, with no sections: for a word no
 * dictionary has, which can still be copied or searched. Unspaced Chinese is
 * cut by the browser's own word list, so this is a guess where the server's
 * answer is not — fine for a search, which is what it's for. Null off a word
 * (a space, punctuation).
 */
export function wordAt(text: string, at: number): DictEntry | null {
  for (const s of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) {
    if (at < s.index || at >= s.index + s.segment.length) continue
    return s.isWordLike ? { term: s.segment, start: s.index, length: s.segment.length, sections: [] } : null
  }
  return null
}

export type DefinitionLine = { text: string; kind: 'sense' | 'sub' | 'example' | 'heading' }

// Dictionary Services hands back an entry as one run of text; these are the
// seams it leaves, from the dictionaries that ship with macOS: the Oxford
// English ones, the Chinese ones, and the English–Chinese 譯典通.
const POS = 'noun|verb|adjective|adverb|pronoun|preposition|conjunction|exclamation|determiner|abbreviation|contraction|prefix|suffix'
// 譯典通's abbreviated ones: n. vt. adj. …
const POS_ABBR = 'n|v|vt|vi|adj|adv|prep|conj|pron|int|abbr|aux'
const ABBR = `(?:${POS_ABBR})\\.(?:,(?:${POS_ABBR})\\.)*`  // vi.,vt.
// …and its closing sections: phrases, derivatives, synonyms, antonyms. Often
// glued to what's before (spite同義參見) and after (同義n. 愛), never to Chinese
// before — which is how 同義詞 inside a gloss stays put.
const ZH_SECTION = '片語|衍生|同義參見|同義(?!參見)|反義'
const SEAMS = new RegExp(
  [
    ' (?=• )',                                                    // a sub-sense
    ' ?(?=▸ )',                                                   // an example
    // A numbered sense, after a stop, a label, or (譯典通) a Chinese gloss.
    `(?<=[.!?\\])］。]|\\p{Script=Han}|\\b(?:${POS})) ?(?=\\d{1,2} \\D)`,
    `(?<=[.!?] )(?=(?:${POS})\\b)`,                               // the next part of speech
    ` (?=(?:${POS_ABBR})\\. )`,                                   // …abbreviated
    `(?<=[.!?] )(?=[A-Z]{5,}\\b)`,                                // ORIGIN, PHRASES, DERIVATIVES…
    '(?<=\\b[A-Z]{5,}) ',                                         // …and what follows one
    '(?=[①-⑳])',                                                  // a Chinese sense
    `(?<=[\\sA-Za-z.,;)]) ?(?=(?:${ZH_SECTION})(?![詞字]))`,          // 譯典通's sections
    `(?<=(?:^|[\\sA-Za-z.,;)])(?:${ZH_SECTION}))(?![詞字]) ?`,         // …and what follows one
  ].join('|'),
  'gu',
)
const HEADING = new RegExp(`^(?:(?:${POS})\\b|${ABBR}|[A-Z]{5,}$|(?:${ZH_SECTION})$)`)
// A part of speech with its labels ("verb [no object]", "vt. ［…］(past …)"),
// then a sense with no number because it's the only one.
const POS_THEN_SENSE = new RegExp(
  `^((?:${POS}|${ABBR})(?: ?\\[[^\\]]*\\]| ?［[^］]*］| ?\\([^)]*\\))*)\\s*(?![\\s[(［]|\\d{1,2} )(.+)$`,
)

const HAN = /\p{Script=Han}/u
const ZHUYIN = /[㄀-ㄯㆠ-ㆿˊˇˋ˙]/
// The Cangjie input code the Chinese dictionaries open their body with, one
// group per character.
const CANGJIE = /^[日月金木水火土竹戈十大中一弓人心手口尸廿山女田難卜重]+$/

/**
 * The Chinese dictionaries spell a head as each character followed by its
 * zhuyin, then the zhuyin again, spaced: 中ㄓㄨㄥ文ㄨㄣˊㄓㄨㄥ ㄨㄣˊ. Back to
 * 中文 and ㄓㄨㄥ ㄨㄣˊ.
 */
function chineseHead(head: string): { word: string; zhuyin: string } {
  const word = [...head].filter((ch) => HAN.test(ch)).join('')
  const z = [...head].filter((ch) => !HAN.test(ch)).join('').trim()
  const marks = z.replace(/\s/g, '')
  const half = marks.length / 2
  if (!Number.isInteger(half) || marks.slice(0, half) !== marks.slice(half)) return { word, zhuyin: '' }
  let i = z.length
  for (let n = 0; n < half; i--) if (!/\s/.test(z[i - 1])) n++
  return { word, zhuyin: z.slice(i).trim() }
}

// The thesaurus separates its examples with `|` too, so what comes before its
// first one ("love noun 1 his friendship…") runs on past the headword into a
// part of speech and a numbered sense. A real head has neither.
const NOT_A_HEADWORD = new RegExp(`\\b(?:${POS})\\b|\\d`)

export type FormattedEntry = { word: string; reading: string; lines: DefinitionLine[] }

/**
 * An entry split into its headword, its reading (the pronunciations between
 * `|`s — 譯典通 gives American and British — with zhuyin first for Chinese),
 * and lines at the senses, examples, parts of speech and sections. `term` is
 * what was looked up, for the entries that open on it without a `|` at all.
 */
export function formatDefinition(definition: string, term = ''): FormattedEntry {
  const head = /^([^|]*)((?:\|[^|]*\|\s*)+)/.exec(definition)
  const m = head && !NOT_A_HEADWORD.test(head[1]) ? head : null
  let body = (m ? definition.slice(m[0].length) : definition).trim()
  let word = m ? m[1].trim() : ''
  const readings = m ? [...m[2].matchAll(/\|([^|]*)\|/g)].map((r) => r[1].trim()) : []
  if (!m && term && body.startsWith(term + ' ')) {
    word = term
    body = body.slice(term.length).trim()
  }
  if (ZHUYIN.test(word)) {
    const zh = chineseHead(word)
    word = zh.word
    if (zh.zhuyin) readings.unshift(zh.zhuyin)
    const code = body.split(' ', [...word].length)
    if (code.every((c) => CANGJIE.test(c))) body = body.split(' ').slice(code.length).join(' ')
  }
  const lines = body
    .split(SEAMS)
    .map((text) => text.trim())
    .filter(Boolean)
    .flatMap((text): DefinitionLine[] => {
      if (text.startsWith('• ')) return [{ text: text.slice(2), kind: 'sub' }]
      if (text.startsWith('▸ ')) return [{ text: text.slice(2), kind: 'example' }]
      const pos = POS_THEN_SENSE.exec(text)
      if (pos) return [{ text: pos[1], kind: 'heading' }, { text: pos[2], kind: 'sense' }]
      return [{ text, kind: HEADING.test(text) ? 'heading' : 'sense' }]
    })
  return { word, reading: readings.filter(Boolean).join(' · '), lines }
}
