import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../components/ChatReplay'
import { PHRASE_MIN_PEOPLE, PHRASE_QUIET_SEC, PHRASE_ROWS, PHRASE_SEED_PEOPLE, PHRASE_WINDOW_SEC, SPIKE_PEOPLE, phraseRuns, phraseScale, phraseWords, phrasesAt } from '../lib/chatPhrases'

let who = 0
/** `text` from someone new at `sec` seconds. */
const say = (sec: number, text: string, a = `@viewer${who++}`): ChatMessage => ({ t: sec * 1000, a, r: [text] })
/** `n` different people saying `text`, a second apart from `sec`. */
const crowd = (sec: number, n: number, text: string) => Array.from({ length: n }, (_, i) => say(sec + i, text))
const inOrder = (...lists: ChatMessage[][]) => lists.flat().sort((a, b) => a.t - b.t)
const label = (m: ChatMessage) => m.r.map((r) => (typeof r === 'string' ? r : r.n)).join('')
const showing = (messages: ChatMessage[], sec: number) =>
  phrasesAt(phraseRuns(messages), sec * 1000).map((r) => [label(r.run.shown), r.count])

describe('phraseWords', () => {
  const words = (text: string) => phraseWords({ r: [text] })

  it('reads the same however it was typed', () => {
    for (const s of ['A', 'a!', ' a ', 'a a a', 'Ａ']) expect(words(s)).toEqual(['a'])
    expect(words('7777')).toEqual(words('777777'))
    expect(words('？？')).toEqual(words('?'))
    expect(words('哈哈哈')).toEqual(words('哈'))
    expect(words('許哥牛逼許哥牛逼')).toEqual(words('許哥牛逼'))
  })

  it('keeps apart what only looks alike', () => {
    expect(words('-1')).not.toEqual(words('1'))
    expect(words('3:0')).not.toEqual(words('3-0'))
    expect(words('77')).not.toEqual(words('7'))
  })

  it('keeps the marks only when they are all there is', () => {
    expect(words('i choose a!!')).toEqual(['i', 'choose', 'a'])
    expect(words('-_-')).toEqual(['-', '_', '-'])
  })

  it('reads a custom emoji as a word, however many were sent', () => {
    const run = { e: 'x.png', n: ':wave:' }
    expect(phraseWords({ r: [run, run, run] })).toEqual([':wave:'])
  })
})

describe('phraseRuns', () => {
  it('takes as many people as it takes, within the window', () => {
    const few = crowd(0, PHRASE_MIN_PEOPLE - 1, 'gg')
    expect(phraseRuns(few)).toEqual([])
    expect(showing(crowd(0, PHRASE_MIN_PEOPLE, 'gg'), PHRASE_MIN_PEOPLE)).toEqual([['gg', PHRASE_MIN_PEOPLE]])
    // As many, but spread out too thin to be saying it together.
    const gap = PHRASE_WINDOW_SEC / (PHRASE_MIN_PEOPLE - 2)
    expect(phraseRuns(Array.from({ length: 12 }, (_, i) => say(i * gap, 'gg')))).toEqual([])
  })

  it('counts a person once, however often they say it', () => {
    const spam = Array.from({ length: 20 }, (_, i) => say(i, 'gg', '@loud'))
    expect(phraseRuns(spam)).toEqual([])
    expect(showing(inOrder(spam, crowd(0, 4, 'gg')), 19)).toEqual([['gg', 5]])
  })

  it('counts a longer message for the phrase it holds', () => {
    const chat = inOrder(crowd(0, 6, 'A'), [say(7, 'i choose a'), say(8, '我選A'), say(9, 'a!')])
    expect(showing(chat, 10)).toEqual([['A', 9]])
  })

  it('shows a vote side by side, the side most people are on first', () => {
    const chat = inOrder(crowd(0, 6, 'a'), crowd(2, 9, 'b'), [say(9, '我選b')])
    expect(showing(chat, 10)).toEqual([['b', 10], ['a', 6]])
  })

  it('leaves a sentence that happens to have the word in it alone', () => {
    const chat = inOrder(crowd(0, 6, 'a'), [say(7, 'that was a good play from the top side of the map')])
    expect(showing(chat, 8)).toEqual([['a', 6]])
    // Nor a word that holds it.
    expect(showing(inOrder(crowd(0, 6, 'a'), [say(7, 'cat')]), 8)).toEqual([['a', 6]])
  })

  it('does not count -1 for 1', () => {
    expect(showing(inOrder(crowd(0, 6, '1'), crowd(0, 5, '-1')), 6)).toEqual(expect.arrayContaining([['1', 6], ['-1', 5]]))
  })

  it('names a phrase as people sent it on its own, the way most did', () => {
    expect(showing(inOrder(crowd(0, 5, '同意'), crowd(1, 8, '同意了')), 9)).toEqual([['同意', 13]])
    expect(showing(inOrder(crowd(0, 2, 'GG'), crowd(2, 5, 'gg')), 7)).toEqual([['gg', 7]])
  })

  it('finds a phrase of two words in what few sent alone and more said in sentences', () => {
    const talk = inOrder(crowd(0, PHRASE_SEED_PEOPLE, '9哥'), [say(3, '9哥加油'), say(4, '又靠9哥'), say(5, '9哥好強')])
    expect(showing(talk, 6)).toEqual([['9哥', PHRASE_SEED_PEOPLE + 3]])
  })

  it('wants the full number on its own for a single word, which is part of anything', () => {
    const talk = inOrder(crowd(0, PHRASE_MIN_PEOPLE - 1, '好'), [say(5, '好看'), say(6, '好強'), say(7, '好爛')])
    expect(phraseRuns(talk)).toEqual([])
  })

  it('does not let a single word swallow a phrase bigger than it', () => {
    const chat = inOrder(crowd(0, 6, '哥哥'), crowd(0, 12, '9哥'))
    expect(showing(chat, 12)).toEqual([['9哥', 12], ['哥哥', 6]])
  })

  it('lets two phrases outweigh a fragment they share', () => {
    const chat = inOrder(crowd(0, 8, '許哥牛逼'), crowd(0, 7, '9哥牛逼'), crowd(1, 5, '牛逼'))
    const rows = Object.fromEntries(showing(chat, 8))
    expect(rows).toMatchObject({ 許哥牛逼: 8, '9哥牛逼': 7 })
  })

  it('leaves out a moderation bot', () => {
    const bot = Array.from({ length: 6 }, (_, i) => say(i, 'Boop!', '@Nightbot'))
    const chat = inOrder(bot, crowd(0, 5, 'Boop!'))
    expect(showing(chat, 5)).toEqual([['Boop!', 5]])
  })
})

describe('a spike', () => {
  // An hour of ordinary chat, a line every ten seconds, for what's usual.
  const chatter = () => Array.from({ length: 360 }, (_, i) => say(i * 10, `閒聊${String.fromCodePoint(0x4e00 + i)}`))
  const TAILS = '好棒讚強猛帥神美酷贏衝來高興哭笑'
  /** Different people saying `head` and something else each, a second apart. */
  const mentions = (sec: number, n: number, head: string) => Array.from({ length: n }, (_, i) => say(sec + i, `${head}${TAILS[i]}`))

  it('is a word many people mention though nobody sends it on its own', () => {
    expect(showing(inOrder(chatter(), mentions(1000, 12, '許哥')), 1012)).toEqual([['許哥', 12]])
  })

  it('takes as many people as it takes', () => {
    expect(showing(inOrder(chatter(), mentions(1000, SPIKE_PEOPLE - 1, '許哥')), 1012)).toEqual([])
  })

  it('shows beside a longer row it has in it, counting everyone', () => {
    const chat = inOrder(chatter(), crowd(1000, 8, '許哥牛逼'), mentions(1000, 12, '許哥'))
    expect(showing(chat, 1012)).toEqual([['許哥', 20], ['許哥牛逼', 8]])
  })

  it('adds nothing beside a row nearly everyone is on', () => {
    const chat = inOrder(chatter(), crowd(1000, 12, '許哥牛逼'), mentions(1000, 2, '許哥'))
    expect(showing(chat, 1013)).toEqual([['許哥牛逼', 12]])
  })

  it('counts for a row of the same words, past the words a message may add', () => {
    const chat = inOrder(chatter(), crowd(1000, 5, '9哥'), Array.from({ length: 8 }, (_, i) => say(1000 + i, `9哥${TAILS[i]}今天真的打得太好了`)))
    expect(showing(chat, 1012)).toEqual([['9哥', 13]])
  })

  it('is out of the ordinary: what the chat always says is not', () => {
    const steady = Array.from({ length: 400 }, (_, i) => say(i, `許哥${TAILS[i % TAILS.length]}${i}`))
    expect(showing(inOrder(chatter(), steady), 200)).toEqual([])
  })

  it('is a whole word, not a piece cut out of one', () => {
    const chat = inOrder(chatter(), Array.from({ length: 12 }, (_, i) => say(1000 + i, `${TAILS[i]}惡意收購`)))
    expect(showing(chat, 1012)).toEqual([['惡意收購', 12]])
  })

  it('is one row for two that come in one message', () => {
    const chat = inOrder(chatter(), crowd(1000, 5, '今年不一樣'), crowd(1000, 3, '今年真不一樣'), crowd(1003, 3, '今年很不一樣'), crowd(1006, 3, '今年好不一樣'))
    expect(showing(chat, 1012)).toEqual([['今年不一樣', 14]])
  })

  it('is named as most people typed it', () => {
    const chat = inOrder(chatter(), Array.from({ length: 12 }, (_, i) => say(1000 + i, `${i < 2 ? 'shy' : 'Shy'} ${TAILS[i]}`)))
    expect(showing(chat, 1012)).toEqual([['Shy', 12]])
  })
})

describe('phrasesAt', () => {
  const runs = phraseRuns(crowd(0, 6, 'gg'))
  const at = (sec: number) => phrasesAt(runs, sec * 1000).map((r) => r.count)

  it('shows from when it caught on, its count only rising', () => {
    expect(at(PHRASE_MIN_PEOPLE - 1.5)).toEqual([])
    expect(at(PHRASE_MIN_PEOPLE - 1)).toEqual([PHRASE_MIN_PEOPLE])
    expect(at(5)).toEqual([6])
  })

  it('stays till it has gone quiet, then goes', () => {
    expect(at(5 + PHRASE_QUIET_SEC)).toEqual([6])
    expect(at(5 + PHRASE_QUIET_SEC + 0.1)).toEqual([])
  })

  it('goes on while someone keeps it going, and starts over after a silence', () => {
    const later = 5 + PHRASE_QUIET_SEC + 1
    expect(phraseRuns(inOrder(crowd(0, 6, 'gg'), [say(5 + PHRASE_QUIET_SEC, 'gg')]))).toHaveLength(1)
    expect(phraseRuns(inOrder(crowd(0, 6, 'gg'), crowd(later, 6, 'gg')))).toHaveLength(2)
  })

  it('is what it was at that moment, after a seek either way', () => {
    expect(at(100)).toEqual([])
    expect(at(5)).toEqual([6])
    expect(at(PHRASE_MIN_PEOPLE - 1)).toEqual([PHRASE_MIN_PEOPLE])
  })

  it('shows those most people are saying, biggest first', () => {
    const lists = Array.from({ length: PHRASE_ROWS + 1 }, (_, i) => crowd(0, 6 + i, `p${i}`))
    const rows = phrasesAt(phraseRuns(inOrder(...lists)), 12000).map((r) => label(r.run.shown))
    expect(rows).toEqual(['p5', 'p4', 'p3', 'p2', 'p1'])
  })

  it('keeps the one that got there first ahead of one that only draws level', () => {
    // 'slow' caught on first, but 'fast' reaches 8 people first, at 9s.
    const slow = [...crowd(0, 5, 'slow'), ...crowd(8, 3, 'slow')]
    const chat = inOrder(slow, crowd(2, 8, 'fast'))
    expect(showing(chat, 9)).toEqual([['fast', 8], ['slow', 7]])
    expect(showing(chat, 10)).toEqual([['fast', 8], ['slow', 8]])
  })
})

describe('phraseScale', () => {
  it('starts at the text’s own size, and grows with the people', () => {
    expect(phraseScale(PHRASE_MIN_PEOPLE)).toBe(1)
    expect(phraseScale(13)).toBeGreaterThan(1.2)
    expect(phraseScale(50)).toBeGreaterThan(phraseScale(13))
  })

  it('stops growing, so a chant can’t fill the picture', () => {
    expect(phraseScale(100)).toBe(1.8)
    expect(phraseScale(5000)).toBe(1.8)
  })
})
