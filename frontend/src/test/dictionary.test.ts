import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatDefinition, lookUp, wordAt } from '../lib/dictionary'

// Trimmed from what macOS's dictionaries actually return.
const LOOK = "look | lo͝ok | verb [no object, usually with adverbial of direction] 1 direct one's gaze toward someone: people were looking at him | they looked up. • (of a building or room) have a view in a specified direction: the rooms look out over Nahant Bay. 2 (look at) think of or regard in a specified way: I look at tennis differently. noun 1 an act of directing one's gaze: here, let me have a look."
const HAPPY = "happy hap·py | ˈhapē | adjective (happier | ˈhapēər |) 1 feeling or showing pleasure: we're just happy that he's still alive. 2 (happy with) satisfied with: I'm happy with his performance. PHRASES as happy as a clam extremely happy. ORIGIN Middle English: from the noun hap1 + -y1."
const XUEXI = '學ㄒㄩㄝˊ習ㄒㄧˊㄒㄩㄝˊ ㄒㄧˊ | xué xí | 竹月弓木 尸一竹日 ①求學受教。 例年輕人做事應抱持著學習的態度。②效法。 例我們應學習革命先烈的精神。'

describe('formatDefinition', () => {
  it('reads the headword and its pronunciation off the head', () => {
    expect(formatDefinition(LOOK)).toMatchObject({ word: 'look', reading: 'lo͝ok' })
  })

  it('untangles a Chinese head into the word, its zhuyin and pinyin, and drops the Cangjie code', () => {
    const got = formatDefinition(XUEXI)
    expect(got).toMatchObject({ word: '學習', reading: 'ㄒㄩㄝˊ ㄒㄧˊ · xué xí' })
    expect(got.lines[0].text).toBe('①求學受教。 例年輕人做事應抱持著學習的態度。')
  })

  it('breaks at parts of speech, numbered senses and sub-senses', () => {
    expect(formatDefinition(LOOK).lines).toEqual([
      { text: 'verb [no object, usually with adverbial of direction]', kind: 'heading' },
      { text: "1 direct one's gaze toward someone: people were looking at him | they looked up.", kind: 'sense' },
      { text: '(of a building or room) have a view in a specified direction: the rooms look out over Nahant Bay.', kind: 'sub' },
      { text: '2 (look at) think of or regard in a specified way: I look at tennis differently.', kind: 'sense' },
      { text: 'noun', kind: 'heading' },
      { text: "1 an act of directing one's gaze: here, let me have a look.", kind: 'sense' },
    ])
  })

  it('gives sections like ORIGIN a line of their own', () => {
    const lines = formatDefinition(HAPPY).lines.map((l) => l.text)
    expect(lines).toContain('PHRASES')
    expect(lines).toContain('as happy as a clam extremely happy.')
    expect(lines).toContain('ORIGIN')
    expect(lines.at(-1)).toBe('Middle English: from the noun hap1 + -y1.')
  })

  it('gives an only sense its own line under the part of speech', () => {
    expect(formatDefinition('ice cream | ˌīs ˈkrēm | noun a soft frozen food: a cone of ice cream. • a portion of it.').lines).toEqual([
      { text: 'noun', kind: 'heading' },
      { text: 'a soft frozen food: a cone of ice cream.', kind: 'sense' },
      { text: 'a portion of it.', kind: 'sub' },
    ])
  })

  it('leaves numbers inside an example alone', () => {
    const lines = formatDefinition('run | rən | verb 1 compete in a race: Dave has run 42 marathons.').lines
    expect(lines.at(-1)!.text).toBe('1 compete in a race: Dave has run 42 marathons.')
  })

  it('breaks a Chinese entry at its circled numbers', () => {
    expect(formatDefinition(XUEXI).lines.map((l) => l.text)).toEqual([
      '①求學受教。 例年輕人做事應抱持著學習的態度。',
      '②效法。 例我們應學習革命先烈的精神。',
    ])
  })
})

describe('lookUp', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks once per term, however the pointer moves inside it', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ term: 'ice cream', start: 7, length: 9, sections: [] })))
    vi.stubGlobal('fetch', fetch)
    const line = 'I love ice cream.'
    expect((await lookUp(line, 8))?.term).toBe('ice cream')
    expect((await lookUp(line, 14))?.term).toBe('ice cream')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0][0])).toBe('/api/dictionary?text=I%20love%20ice%20cream.&at=8')
  })

  it('remembers where there was nothing', async () => {
    const fetch = vi.fn(async () => new Response('null'))
    vi.stubGlobal('fetch', fetch)
    expect(await lookUp('a, b', 1)).toBeNull()
    expect(await lookUp('a, b', 1)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('stops asking once the server has no dictionary', async () => {
    const fetch = vi.fn(async () => new Response('{"detail":"No dictionary on this server"}', { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    expect(await lookUp('one', 0)).toBeNull()
    expect(await lookUp('two', 0)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('wordAt', () => {
  it('finds the word under the pointer, for one no dictionary has', () => {
    expect(wordAt("Let's re-enter Zxqvland.", 17)).toEqual({ term: 'Zxqvland', start: 15, length: 8, sections: [] })
    expect(wordAt("Let's re-enter Zxqvland.", 2)?.term).toBe("Let's")
  })

  it('cuts an unspaced Chinese line into its words', () => {
    expect(wordAt('我們今天去公園。', 6)).toMatchObject({ term: '公園', start: 5, length: 2 })
  })

  it('finds nothing on a space or punctuation', () => {
    expect(wordAt('Hi, you.', 2)).toBeNull()
    expect(wordAt('Hi, you.', 3)).toBeNull()
  })
})

describe('formatDefinition, English–Chinese (譯典通)', () => {
  const LOVE = "love | 美 lʌv | | 英 lʌv | n. (plural loves) 1 愛；熱愛 ［不可數名詞。］［（+for/of/to）］▸ My mother's love for me was very great.我母親對我的愛是很深的。 2 戀愛，愛情 ［不可數名詞。］6 (夫婦間的愛稱) 親愛的，寶貝 7 【體育】 零分 vt. ［指該動詞通常不用進行式。］(past loved, pp loved, present loving) 1 愛，熱愛 ▸ You should love your students.你應該愛你的學生。"

  it('reads both pronunciations', () => {
    expect(formatDefinition(LOVE)).toMatchObject({ word: 'love', reading: '美 lʌv · 英 lʌv' })
  })

  it('breaks at its abbreviated parts of speech, numbers and examples', () => {
    expect(formatDefinition(LOVE).lines).toEqual([
      { text: 'n. (plural loves)', kind: 'heading' },
      { text: '1 愛；熱愛 ［不可數名詞。］［（+for/of/to）］', kind: 'sense' },
      { text: "My mother's love for me was very great.我母親對我的愛是很深的。", kind: 'example' },
      { text: '2 戀愛，愛情 ［不可數名詞。］', kind: 'sense' },
      { text: '6 (夫婦間的愛稱) 親愛的，寶貝', kind: 'sense' },
      { text: '7 【體育】 零分', kind: 'sense' },
      { text: 'vt. ［指該動詞通常不用進行式。］(past loved, pp loved, present loving)', kind: 'heading' },
      { text: '1 愛，熱愛', kind: 'sense' },
      { text: 'You should love your students.你應該愛你的學生。', kind: 'example' },
    ])
  })

  it('takes the headword from the term when the entry has no pronunciation', () => {
    const got = formatDefinition('ice cream n. (plural ice creams) 冰淇淋 ［不可數名詞。］▸ The child ate three.那孩子吃了三個。', 'ice cream')
    expect(got.word).toBe('ice cream')
    expect(got.lines).toEqual([
      { text: 'n. (plural ice creams)', kind: 'heading' },
      { text: '冰淇淋 ［不可數名詞。］', kind: 'sense' },
      { text: 'The child ate three.那孩子吃了三個。', kind: 'example' },
    ])
  })

  it('reads a Chinese head with no Cangjie code after it', () => {
    const got = formatDefinition('學ㄒㄩㄝˊ習ㄒㄧˊ ㄒㄩㄝˊ ㄒㄧˊ | xué xí | to learn; to study ▸ 他致力於學習法語。He applied himself to learning French. ')
    expect(got).toMatchObject({ word: '學習', reading: 'ㄒㄩㄝˊ ㄒㄧˊ · xué xí' })
    expect(got.lines.map((l) => l.kind)).toEqual(['sense', 'example'])
  })
})

describe('formatDefinition, 譯典通 sections', () => {
  it('gives phrases, synonyms and antonyms headings of their own', () => {
    const tail = 'love | lʌv | vi. 愛 片語 fall in love with 愛上 衍生 a. loveless 同義n. 愛；喜好affection, devotionvt. 愛adore反義vi.,vt. 愛；疼愛hate, abhorn. 愛hatred, spite同義參見passion, heart'
    expect(formatDefinition(tail).lines).toEqual([
      { text: 'vi.', kind: 'heading' },
      { text: '愛', kind: 'sense' },
      { text: '片語', kind: 'heading' },
      { text: 'fall in love with 愛上', kind: 'sense' },
      { text: '衍生', kind: 'heading' },
      { text: 'a. loveless', kind: 'sense' },
      { text: '同義', kind: 'heading' },
      { text: 'n.', kind: 'heading' },
      { text: '愛；喜好affection, devotionvt. 愛adore', kind: 'sense' },
      { text: '反義', kind: 'heading' },
      { text: 'vi.,vt.', kind: 'heading' },
      { text: '愛；疼愛hate, abhorn. 愛hatred, spite', kind: 'sense' },
      { text: '同義參見', kind: 'heading' },
      { text: 'passion, heart', kind: 'sense' },
    ])
  })

  it('leaves 同義詞 inside a gloss alone', () => {
    expect(formatDefinition('a | ə | 1 「好」的同義詞').lines).toEqual([{ text: '1 「好」的同義詞', kind: 'sense' }])
  })
})

describe('formatDefinition, the thesaurus', () => {
  it('reads its examples, which it also separates with |, as examples rather than a head', () => {
    const got = formatDefinition('love noun 1 his friendship with Helen grew into love | she has a great love for her children. deep affection, fondness.', 'love')
    expect(got.word).toBe('love')
    expect(got.reading).toBe('')
    expect(got.lines[0]).toEqual({ text: 'noun', kind: 'heading' })
  })
})
