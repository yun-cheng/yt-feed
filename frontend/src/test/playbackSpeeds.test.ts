/**
 * The speeds the player offers: the `playback_speeds` setting, the text field
 * that edits it, and the stepping the slower/faster keys do through it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  DEFAULT_SPEEDS, MAX_SPEEDS, cleanSpeeds, formatSpeeds, nextSpeed,
  parseSpeeds, playbackSpeeds, setSpeedDefaults,
} from '../lib/playbackSpeeds'

afterEach(() => { setSpeedDefaults(undefined) })

describe('the stored list', () => {
  it('ships as YouTube’s own', () => {
    expect(playbackSpeeds()).toEqual(DEFAULT_SPEEDS)
  })

  it('takes the list you saved', () => {
    setSpeedDefaults([1, 1.5, 2])
    expect(playbackSpeeds()).toEqual([1, 1.5, 2])
  })

  it('leaves the default standing rather than emptying the menu', () => {
    setSpeedDefaults('nonsense')
    expect(playbackSpeeds()).toEqual(DEFAULT_SPEEDS)
    setSpeedDefaults([])
    expect(playbackSpeeds()).toEqual(DEFAULT_SPEEDS)
  })

  it('sorts, de-duplicates and drops what isn’t a speed', () => {
    expect(cleanSpeeds([2, 1, 2, 'x', 99, 0.01, 0.5])).toEqual([0.5, 1, 2])
  })

  it('always leaves a way back to normal speed', () => {
    // Every video starts at 1×; a menu without it is a menu with no way home.
    expect(cleanSpeeds([0.5, 2])).toEqual([0.5, 1, 2])
  })

  it('keeps the menu to a length that fits over a video', () => {
    const many = Array.from({ length: 30 }, (_, i) => 0.1 + i * 0.1)
    expect(cleanSpeeds(many)).toHaveLength(MAX_SPEEDS)
  })
})

describe('the settings field', () => {
  it('reads the list back the way it writes it', () => {
    expect(parseSpeeds(formatSpeeds([0.5, 1, 2]))).toEqual([0.5, 1, 2])
  })

  it('takes commas, spaces and a trailing ×, which is how people write speeds', () => {
    expect(parseSpeeds('0.5x 1 1.5× , 2')).toEqual([0.5, 1, 1.5, 2])
  })

  it('refuses text that isn’t speeds, rather than saving what it could salvage', () => {
    // Saving "1" out of "1, fsat" would be a menu the person didn't ask for.
    expect(parseSpeeds('1, fast')).toBeNull()
    expect(parseSpeeds('')).toBeNull()
  })

  it('rounds, so typing doesn’t leave 1.1000000000000001 in a menu', () => {
    expect(parseSpeeds('1, 1.006')).toEqual([1, 1.01])
  })
})

describe('nextSpeed — one step along the list', () => {
  it('steps up and down through the speeds in force', () => {
    expect(nextSpeed(1, 1)).toBe(1.25)
    expect(nextSpeed(1, -1)).toBe(0.75)
  })

  it('steps through YOUR list once you’ve chosen one', () => {
    setSpeedDefaults([1, 3])
    expect(nextSpeed(1, 1)).toBe(3)
  })

  it('stops at both ends rather than wrapping', () => {
    expect(nextSpeed(2, 1)).toBe(2)
    expect(nextSpeed(0.25, -1)).toBe(0.25)
  })

  it('steps from the nearest speed when the player is on one of its own', () => {
    // A <video> takes any number at all, and the list can change under a video
    // that's already playing.
    expect(nextSpeed(1.3, 1)).toBe(1.5)
    expect(nextSpeed(1.3, -1)).toBe(1)
  })
})
