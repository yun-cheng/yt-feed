import { describe, it, expect } from 'vitest'
import { chapterAt, chapterMask } from '../lib/chapters'

const CH = [
  { start: 0, end: 60, title: 'a' },
  { start: 60, end: 90, title: 'b' },
  { start: 90, end: 120, title: 'c' },
]

describe('chapterAt', () => {
  it('finds the chapter a moment falls in, boundaries going to the next one', () => {
    expect(chapterAt(CH, 0)?.title).toBe('a')
    expect(chapterAt(CH, 59.9)?.title).toBe('a')
    expect(chapterAt(CH, 60)?.title).toBe('b')
    expect(chapterAt(CH, 119)?.title).toBe('c')
  })

  it('keeps the last chapter past its end — the player’s duration can run long', () => {
    expect(chapterAt(CH, 121)?.title).toBe('c')
  })

  it('has nothing to say without chapters', () => {
    expect(chapterAt([], 10)).toBeNull()
    expect(chapterAt(undefined, 10)).toBeNull()
  })
})

describe('chapterMask', () => {
  it('cuts once per chapter start after the first', () => {
    const mask = chapterMask(CH, 120)!
    expect(mask.match(/transparent calc/g)).toHaveLength(4)
    expect(mask).toContain('calc(50.000% - 2px)')
    expect(mask).toContain('calc(75.000% + 2px)')
  })

  it('draws no cut at either end, or before the duration is known', () => {
    expect(chapterMask([{ start: 0, end: 120, title: 'only' }], 120)).toBeNull()
    expect(chapterMask(CH, 0)).toBeNull()
    expect(chapterMask([], 120)).toBeNull()
  })
})
