import { describe, it, expect } from 'vitest'
import { qualityLabel, heightLabel } from '../lib/quality'

describe('qualityLabel', () => {
  it('should translate the names that say nothing on their own', () => {
    // The point of the table: "large" is 480p and "medium" is 360p, which no
    // one would guess.
    expect(qualityLabel('large')).toBe('480p')
    expect(qualityLabel('medium')).toBe('360p')
    expect(qualityLabel('small')).toBe('240p')
    expect(qualityLabel('tiny')).toBe('144p')
  })

  it('should translate the hd names', () => {
    expect(qualityLabel('hd720')).toBe('720p')
    expect(qualityLabel('hd1080')).toBe('1080p')
    expect(qualityLabel('hd1440')).toBe('1440p')
    expect(qualityLabel('hd2160')).toBe('2160p')
  })

  it('should show nothing while the player has not settled', () => {
    // "unknown" is what the embed reports until playback starts, and "auto"
    // says nothing about what you're seeing. Both hide the label rather than
    // put a word where a number belongs.
    expect(qualityLabel('unknown')).toBeNull()
    expect(qualityLabel('auto')).toBeNull()
    expect(qualityLabel('')).toBeNull()
    expect(qualityLabel(null)).toBeNull()
    expect(qualityLabel(undefined)).toBeNull()
  })

  it('should show nothing for a name it does not know', () => {
    // YouTube adds these over time; an unrecognised one must not reach the bar
    // as raw jargon.
    expect(qualityLabel('hd4320')).toBeNull()
  })

  it('should pass through the one name that refuses to be a number', () => {
    // Predates the hd* names and means only "above 1080p".
    expect(qualityLabel('highres')).toBe('HD')
  })
})

describe('heightLabel', () => {
  it('should read a file height straight off', () => {
    expect(heightLabel(1080)).toBe('1080p')
    expect(heightLabel(480)).toBe('480p')
  })

  it('should show nothing before the metadata lands', () => {
    // A <video> reports height 0 until loadedmetadata.
    expect(heightLabel(0)).toBeNull()
    expect(heightLabel(null)).toBeNull()
    expect(heightLabel(undefined)).toBeNull()
  })
})
