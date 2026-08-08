import { describe, it, expect } from 'vitest'
import {
  DEFAULT_RANGE,
  MAX_TICK,
  TICK_DAYS,
  TICK_LABELS,
  clampRange,
  formatAge,
  nearestTick,
  parseAge,
  rangeBounds,
  rangeLabel,
  sameRange,
} from '../lib/timeWindow'

describe('the ladder', () => {
  it('labels every tick', () => {
    expect(TICK_LABELS).toHaveLength(TICK_DAYS.length)
    expect(MAX_TICK).toBe(TICK_DAYS.length - 1)
  })

  it('runs strictly older left to right', () => {
    for (let i = 1; i < TICK_DAYS.length; i++) {
      expect(TICK_DAYS[i]).toBeGreaterThan(TICK_DAYS[i - 1])
    }
  })

  it('opens on the past three days', () => {
    expect(DEFAULT_RANGE).toEqual(parseAge('0-3'))
  })
})

describe('clampRange', () => {
  it('leaves a valid range alone', () => {
    expect(clampRange({ lo: 2, hi: 5 })).toEqual({ lo: 2, hi: 5 })
  })

  it('never lets the band collapse to nothing', () => {
    expect(clampRange({ lo: 4, hi: 4 })).toEqual({ lo: 3, hi: 4 })
    expect(clampRange({ lo: 0, hi: 0 })).toEqual({ lo: 0, hi: 1 })
  })

  it('puts a reversed pair back in order', () => {
    expect(clampRange({ lo: 6, hi: 2 })).toEqual({ lo: 2, hi: 6 })
  })

  it('pulls out-of-bounds ticks onto the ladder', () => {
    expect(clampRange({ lo: -5, hi: 99 })).toEqual({ lo: 0, hi: MAX_TICK })
  })

  it('rounds fractional ticks', () => {
    expect(clampRange({ lo: 1.4, hi: 4.6 })).toEqual({ lo: 1, hi: 5 })
  })
})

describe('nearestTick', () => {
  it('is exact on every finite rung of the ladder', () => {
    TICK_DAYS.forEach((d, i) => {
      if (Number.isFinite(d)) expect(nearestTick(d)).toBe(i)
    })
  })

  it('snaps a day count that sits between ticks', () => {
    expect(TICK_DAYS[nearestTick(6)]).toBe(7)
    expect(TICK_DAYS[nearestTick(400)]).toBe(365)
  })

  it('breaks a dead tie toward the tighter window', () => {
    // 5 is two days from both 3 and 7 — the backend resolves it the same way.
    expect(TICK_DAYS[nearestTick(5)]).toBe(3)
  })

  it('never reaches the unbounded rung from a day count', () => {
    // However large the number, "a lot of days" is 1y — only the `all` token
    // itself means everything, so a hand-edited URL can't fall off the end.
    expect(nearestTick(99_999)).toBe(TICK_DAYS.indexOf(365))
  })
})

describe('the wire format', () => {
  it('round-trips every pair on the ladder', () => {
    for (let lo = 0; lo < MAX_TICK; lo++) {
      for (let hi = lo + 1; hi <= MAX_TICK; hi++) {
        const r = { lo, hi }
        expect(parseAge(formatAge(r))).toEqual(r)
      }
    }
  })

  it('spells the range in days, not indices', () => {
    expect(formatAge({ lo: 2, hi: 4 })).toBe('3-14')
  })

  it('spells the unbounded edge as a word, not a number', () => {
    expect(formatAge({ lo: 0, hi: MAX_TICK })).toBe('0-all')
    expect(formatAge({ lo: 5, hi: MAX_TICK })).toBe('30-all')
    expect(parseAge('0-all')).toEqual({ lo: 0, hi: MAX_TICK })
    expect(parseAge('30-all')).toEqual({ lo: 5, hi: MAX_TICK })
  })

  it('snaps a hand-edited range instead of giving up', () => {
    expect(parseAge('0-6')).toEqual({ lo: 0, hi: 3 })
  })

  it('rejects what it cannot read', () => {
    for (const bad of ['', null, undefined, 'abc', '3', '3-', '-3', '1-2-3', '0--3']) {
      expect(parseAge(bad)).toBeNull()
    }
  })

  it('refuses to yield an empty window', () => {
    expect(parseAge('7-7')).toEqual({ lo: 2, hi: 3 })
  })
})

describe('rangeLabel', () => {
  it('reads as a span when it starts at now', () => {
    expect(rangeLabel({ lo: 0, hi: 2 })).toBe('Past 3d')
  })

  it('reads as two edges when it does not', () => {
    expect(rangeLabel({ lo: 2, hi: 4 })).toBe('3d–2w ago')
  })
})

describe('rangeBounds', () => {
  const DAY = 86_400_000
  const now = 1_700_000_000_000

  it('turns ticks into the instants either side of the window', () => {
    const { from, to } = rangeBounds({ lo: 2, hi: 4 }, now)
    expect(to).toBe(now - 3 * DAY)
    expect(from).toBe(now - 14 * DAY)
  })

  it('ends at now when the window starts at now', () => {
    expect(rangeBounds({ lo: 0, hi: 2 }, now).to).toBe(now)
  })
})

describe('sameRange', () => {
  it('compares by value', () => {
    expect(sameRange({ lo: 1, hi: 3 }, { lo: 1, hi: 3 })).toBe(true)
    expect(sameRange({ lo: 1, hi: 3 }, { lo: 1, hi: 4 })).toBe(false)
  })
})
