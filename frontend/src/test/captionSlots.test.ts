import { describe, expect, it } from 'vitest'
import { pickMain, pickSecond } from '../lib/captionSlots'

describe('pickMain', () => {
  it('moves the main it replaces into an empty Second', () => {
    expect(pickMain('zh', 'en', '')).toEqual(['zh', 'en'])
  })

  it('leaves a Second already chosen where it is', () => {
    expect(pickMain('zh', 'en', 'ja')).toEqual(['zh', 'ja'])
  })

  it('just turns captions on when nothing was showing', () => {
    expect(pickMain('en', '', '')).toEqual(['en', ''])
  })

  it('toggles the active main off, promoting the second', () => {
    expect(pickMain('en', 'en', 'ja')).toEqual(['ja', ''])
  })

  it('moves the second up, clearing it', () => {
    expect(pickMain('ja', 'en', 'ja')).toEqual(['ja', ''])
  })
})

describe('pickSecond', () => {
  it('sets a new second', () => {
    expect(pickSecond('ja', 'en', '')).toEqual(['en', 'ja'])
  })

  it('swaps when the main is picked', () => {
    expect(pickSecond('en', 'en', 'ja')).toEqual(['ja', 'en'])
  })

  it('toggles the active second off', () => {
    expect(pickSecond('ja', 'en', 'ja')).toEqual(['en', ''])
  })
})
