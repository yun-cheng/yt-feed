import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timeAgo, formatTime } from '../lib/time'

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

describe('timeAgo', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-20T12:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  it('reads a naive stamp as UTC', () => {
    expect(timeAgo('2026-09-20T09:00:00.000000')).toBe('3h ago')
  })

  it('reads a stamp that carries its own offset', () => {
    expect(timeAgo('2026-04-16T12:00:04+00:00')).toBe('5mo ago')
    expect(timeAgo('2026-09-20T09:00:00Z')).toBe('3h ago')
  })

  it('says nothing for a missing or unreadable stamp', () => {
    expect(timeAgo('')).toBe('')
    expect(timeAgo('soon')).toBe('')
  })
})
