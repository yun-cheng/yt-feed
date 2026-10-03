import { afterEach, describe, expect, it } from 'vitest'
import { CAPTION_PREFS_KEY, CAPTION_SIZE_MAX, CAPTION_SIZE_MIN, loadCaptionPrefs, roundSize } from '../lib/captionPrefs'

const save = (v: unknown) => localStorage.setItem(CAPTION_PREFS_KEY, typeof v === 'string' ? v : JSON.stringify(v))

afterEach(() => { localStorage.clear() })

describe('loadCaptionPrefs', () => {
  it('starts off, word by word, at the bottom, at YouTube’s size', () => {
    expect(loadCaptionPrefs()).toEqual({ on: false, mode: 'word', pos: 'bottom', size: 1 })
  })

  it('reads back what was saved', () => {
    save({ on: true, mode: 'sentence', pos: 'top', size: 1.5 })
    expect(loadCaptionPrefs()).toEqual({ on: true, mode: 'sentence', pos: 'top', size: 1.5 })
  })

  it('reads the old name for whole-sentence mode', () => {
    save({ mode: 'line' })
    expect(loadCaptionPrefs().mode).toBe('sentence')
  })

  it('clamps a size an older build saved, rather than dropping it', () => {
    save({ size: 4 })
    expect(loadCaptionPrefs().size).toBe(CAPTION_SIZE_MAX)
    save({ size: 0.25 })
    expect(loadCaptionPrefs().size).toBe(CAPTION_SIZE_MIN)
  })

  it('falls back to the defaults on a value it can’t read', () => {
    save({ on: 'yes', mode: 'karaoke', pos: 'middle', size: 'big' })
    expect(loadCaptionPrefs()).toEqual({ on: false, mode: 'word', pos: 'bottom', size: 1 })
    save('{not json')
    expect(loadCaptionPrefs()).toEqual({ on: false, mode: 'word', pos: 'bottom', size: 1 })
  })
})

describe('roundSize', () => {
  it('keeps a tenth a tenth', () => {
    expect(roundSize(1.1 + 0.1)).toBe(1.2)
    expect(roundSize(0.1 * 3)).toBe(CAPTION_SIZE_MIN)
    expect(roundSize(2.95)).toBe(3)
  })
})
