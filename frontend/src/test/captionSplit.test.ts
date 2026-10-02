import { describe, expect, it } from 'vitest'
import { MAX_CJK_LINE_CHARS, MAX_LINE_CHARS, splitTimed } from '../lib/captionSplit'

const zh = '這個模型在訓練的時候會先看過大量的文字，然後學會預測下一個字是什麼，所以它其實並不知道自己在說什麼，只是很會猜而已。'

describe('splitTimed', () => {
  it('leaves a line that fits whole', () => {
    expect(splitTimed({ start: 1, end: 3, text: ' 你好。 ' })).toEqual([{ start: 1, end: 3, text: '你好。' }])
  })

  it('cuts a long Chinese sentence into evenly sized pieces under the limit', () => {
    const out = splitTimed({ start: 10, end: 20, text: zh })
    expect(out.length).toBe(Math.ceil(zh.length / MAX_CJK_LINE_CHARS))
    expect(out.map((p) => p.text).join('')).toBe(zh)
    for (const p of out) expect(p.text.length).toBeLessThanOrEqual(MAX_CJK_LINE_CHARS)
    // At a comma when one is near the even point, never with one leading a piece.
    expect(out[0].text.endsWith('，')).toBe(true)
    for (const p of out) expect(p.text[0]).not.toMatch(/[，。]/)
  })

  it('shares the span out by characters, piece after piece', () => {
    const out = splitTimed({ start: 10, end: 20, text: zh })
    expect(out[0].start).toBe(10)
    expect(out[out.length - 1].end).toBe(20)
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeCloseTo(out[i - 1].end)
    expect(out[0].end - out[0].start).toBeCloseTo((10 * out[0].text.length) / zh.length)
  })

  it('breaks Latin text at spaces, never inside a word', () => {
    const en = 'The model reads a great deal of text while it trains and learns to guess the next word, so it never really knows what it is saying at all.'
    const out = splitTimed({ start: 0, end: 8, text: en })
    expect(out.length).toBe(Math.ceil(en.length / MAX_LINE_CHARS))
    expect(out.map((p) => p.text).join(' ')).toBe(en)
  })

  it('breaks Chinese between words, not inside one', () => {
    const text = '量子電腦利用疊加態與糾纏同時處理大量可能性因此在特定問題上能夠遠遠超越傳統電腦的運算速度與效率表現'
    const words = new Set([...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)].map((s) => s.index))
    const out = splitTimed({ start: 0, end: 6, text })
    expect(out.length).toBe(2)
    expect(words.has(out[0].text.length)).toBe(true)
  })

  it('keeps an opening quote with what it opens', () => {
    const text = '他說了一句很長很長很長很長很長很長很長很長的話：「我們明天早上八點在車站集合，不要遲到，也不要忘記帶護照和車票」'
    for (const p of splitTimed({ start: 0, end: 6, text })) expect(p.text.endsWith('「')).toBe(false)
  })

  it('comes back whole when there is no end to share out', () => {
    expect(splitTimed({ start: 0, end: Number.POSITIVE_INFINITY, text: zh })).toHaveLength(1)
  })
})
