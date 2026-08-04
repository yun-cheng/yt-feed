import { describe, it, expect } from 'vitest'
import { formatTime } from '../lib/time'

describe('formatTime', () => {
  it('formats under a minute', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(5)).toBe('0:05')
    expect(formatTime(59)).toBe('0:59')
  })

  it('formats minutes without a leading zero', () => {
    expect(formatTime(60)).toBe('1:00')
    expect(formatTime(1234)).toBe('20:34')
  })

  it('grows to h:mm:ss only once there is an hour to show', () => {
    expect(formatTime(3599)).toBe('59:59')
    expect(formatTime(3600)).toBe('1:00:00')
    expect(formatTime(3661)).toBe('1:01:01')
    expect(formatTime(36000)).toBe('10:00:00')
  })

  it('truncates rather than rounding', () => {
    // The clock has to agree with the position it was read from; rounding up
    // would show 0:01 while the player still reports 0.
    expect(formatTime(0.9)).toBe('0:00')
    expect(formatTime(59.9)).toBe('0:59')
  })

  it('clamps a negative time to zero', () => {
    // currentTime can read fractionally negative right after a seek to 0.
    expect(formatTime(-5)).toBe('0:00')
  })
})
