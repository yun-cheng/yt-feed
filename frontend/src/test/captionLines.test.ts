import { describe, expect, it } from 'vitest'
import { linesAt, sentenceLinesAt, toSentences, type Cue } from '../lib/captionLines'
import { MAX_LINE_CHARS } from '../lib/captionSplit'

// An auto-caption cue: each word timed, every word after the first carrying
// its own leading space, as YouTube's word tracks do.
function auto(start: number, dur: number, text: string, step = 0.3): Cue {
  const words = text.split(' ').map((w, i) => ({ t: start + i * step, text: (i ? ' ' : '') + w }))
  return { start, dur, text, words }
}
const manual = (start: number, dur: number, text: string): Cue => ({ start, dur, text })

describe('linesAt', () => {
  it('shows every cue spanning the moment, oldest first — the rolling two lines', () => {
    const cues = [auto(2, 4, 'second line here'), auto(0, 4, 'first line here')]
    expect(linesAt(cues, 3).map((l) => l.text)).toEqual(['first line here', 'second line here'])
  })

  it('reveals an auto cue word by word, a hair ahead of the play head', () => {
    const cue = auto(0, 5, 'one two three', 1)
    expect(linesAt([cue], 0.5)).toEqual([{ text: 'one', wordByWord: true }])
    // The second word is due at 1s; 0.9 is within the lookahead.
    expect(linesAt([cue], 0.9)[0].text).toBe('one two')
    expect(linesAt([cue], 2)[0].text).toBe('one two three')
  })

  it('shows a manual cue whole, and centred', () => {
    expect(linesAt([manual(0, 3, 'All at once.')], 0.1)).toEqual([{ text: 'All at once.', wordByWord: false }])
  })

  it('shows nothing before a cue, after it, or without cues', () => {
    const cues = [manual(1, 2, 'Hi')]
    expect(linesAt(cues, 0.5)).toEqual([])
    expect(linesAt(cues, 3)).toEqual([])
    expect(linesAt(null, 1)).toEqual([])
  })
})

describe('toSentences', () => {
  it('stitches a sentence that runs across cues, and breaks one that ends mid-cue', () => {
    const cues = [auto(0, 2, 'We went out. The'), auto(2, 2, 'rain had stopped.')]
    const s = toSentences(cues)
    expect(s.map((x) => x.text)).toEqual(['We went out.', 'The rain had stopped.'])
    // Each starts on its own first word, and holds until the next begins.
    expect(s[1].start).toBeCloseTo(0.9)
    expect(s[0].end).toBe(s[1].start)
    expect(s[1].end).toBe(Number.POSITIVE_INFINITY)
  })

  it('joins CJK words without spaces', () => {
    const cues: Cue[] = [
      { start: 0, dur: 2, text: '我们今天', words: [{ t: 0, text: '我们' }, { t: 1, text: '今天' }] },
      { start: 2, dur: 2, text: '去公园。', words: [{ t: 2, text: '去' }, { t: 3, text: '公园。' }] },
    ]
    expect(toSentences(cues).map((x) => x.text)).toEqual(['我们今天去公园。'])
  })

  it('keeps to one line per cue on a track with no sentence punctuation', () => {
    const cues = [manual(0, 2, '大家好'), manual(2, 2, '今天来聊聊'), manual(5, 2, '这件事')]
    expect(toSentences(cues)).toEqual([
      { start: 0, end: 2, text: '大家好' },
      { start: 2, end: 5, text: '今天来聊聊' },
      { start: 5, end: Number.POSITIVE_INFINITY, text: '这件事' },
    ])
  })

  it('cuts an over-long sentence into even pieces, not a runt at its only comma', () => {
    const text = 'She woke up, and the morning light came in through the window while the kettle on the stove began to sing and the dog barked twice at nothing in particular.'
    expect(text.length).toBeGreaterThan(MAX_LINE_CHARS)
    const s = toSentences([auto(0, 60, text)])
    expect(s).toHaveLength(2)
    for (const piece of s) {
      expect(piece.text.length).toBeLessThanOrEqual(MAX_LINE_CHARS)
      expect(piece.text.length).toBeGreaterThan(text.length / 3)
    }
    // Nothing lost or doubled at the cut, and the second piece starts on its
    // own first word's time.
    expect(s.map((x) => x.text).join(' ')).toBe(text)
    expect(s[1].start).toBeGreaterThan(0)
  })

  it('leaves a long sentence whole for the transcript', () => {
    const text = 'This sentence is long enough that the caption block would cut it into pieces, but the transcript panel has the width to show it whole.'
    expect(toSentences([auto(0, 30, text)], false).map((x) => x.text)).toEqual([text])
  })

  it('keeps a trailing run with no full stop', () => {
    const cues = [auto(0, 2, 'Done. and then')]
    expect(toSentences(cues).map((x) => x.text)).toEqual(['Done.', 'and then'])
  })

  it('is empty without cues', () => {
    expect(toSentences(null)).toEqual([])
    expect(toSentences([])).toEqual([])
  })
})

describe('sentenceLinesAt', () => {
  it('shows the sentence the play head is in, centred', () => {
    const s = [{ start: 0, end: 2, text: 'One.' }, { start: 2, end: Number.POSITIVE_INFINITY, text: 'Two.' }]
    expect(sentenceLinesAt(s, 1)).toEqual([{ text: 'One.', wordByWord: false }])
    expect(sentenceLinesAt(s, 2)).toEqual([{ text: 'Two.', wordByWord: false }])
    expect(sentenceLinesAt(s, -1)).toEqual([])
  })
})
