/**
 * The keys the player answers to: the table every handler reads, and the
 * `shortcuts` setting that moves an action off its default key.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  ACTIONS, NO_KEY, actionFor, conflictWith, keyFor, keyLabel, normalizeKey,
  setShortcutOverrides, shortcutLabel, shortcutOverrides,
} from '../lib/shortcuts'

afterEach(() => { setShortcutOverrides({}) })

describe('the built-in keys', () => {
  it('reads a keypress as what it does', () => {
    expect(actionFor('k')).toBe('playPause')
    expect(actionFor('ArrowUp')).toBe('volumeUp')
    expect(actionFor('.')).toBe('speedUp')
    expect(actionFor(',')).toBe('speedDown')
    expect(actionFor('[')).toBe('loopStart')
  })

  it('means nothing by a key nothing is on', () => {
    expect(actionFor('q')).toBeNull()
  })

  it('gives every action its own key, so no two ever race', () => {
    const keys = ACTIONS.map((a) => a.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('reads a capital as the key under it', () => {
    // Shift-K is still K — you get here by typing a capital a moment ago.
    expect(actionFor('K')).toBe('playPause')
    expect(normalizeKey('K')).toBe('k')
  })

  it('reads a shifted punctuation key as the key under it', () => {
    // `<` and `,` are one physical key, as are the three brackets.
    expect(actionFor('<')).toBe('speedDown')
    expect(actionFor('>')).toBe('speedUp')
    expect(actionFor('|')).toBe('loopClear')
  })
})

describe('a key you moved', () => {
  it('answers on the new key, and no longer on the old one', () => {
    setShortcutOverrides({ mute: 'x' })
    expect(actionFor('x')).toBe('mute')
    expect(actionFor('m')).toBeNull()
  })

  it('leaves every other action where it was', () => {
    setShortcutOverrides({ mute: 'x' })
    expect(actionFor('k')).toBe('playPause')
  })

  it('is what the player’s tooltips say', () => {
    setShortcutOverrides({ fullscreen: 'v' })
    expect(shortcutLabel('fullscreen')).toBe('V')
  })

  it('is stored unshifted, whichever way it was pressed', () => {
    setShortcutOverrides({ mute: '<' })
    expect(keyFor('mute')).toBe(',')
  })

  it('drops an action or a key it can’t use rather than shadowing a default', () => {
    // ('' is not among these — that one means something; see below.)
    setShortcutOverrides({ notAnAction: 'x', fullscreen: 7 })
    expect(shortcutOverrides()).toEqual({})
    expect(actionFor('f')).toBe('fullscreen')
  })

  it('reads a value that is no map at all as nothing stored', () => {
    setShortcutOverrides('mute=x')
    expect(shortcutOverrides()).toEqual({})
  })
})

describe('an action with no key', () => {
  it('answers to nothing at all', () => {
    setShortcutOverrides({ mute: '' })
    expect(actionFor('m')).toBeNull()
    expect(actionFor('')).toBeNull()
  })

  it('is kept as its own answer, not read as never touched', () => {
    // "off" and "back on its default" are different intentions.
    setShortcutOverrides({ mute: '' })
    expect(shortcutOverrides()).toEqual({ mute: '' })
  })

  it('leaves every other key alone', () => {
    setShortcutOverrides({ mute: '' })
    expect(actionFor('k')).toBe('playPause')
  })

  it('takes no key from anyone, so several can have none', () => {
    setShortcutOverrides({ mute: '', pin: '' })
    expect(conflictWith('captions', '', { mute: '', pin: '' })).toBeNull()
  })

  it('shows a dash where a tooltip would name the key', () => {
    setShortcutOverrides({ mute: '' })
    expect(shortcutLabel('mute')).toBe(NO_KEY)
  })
})

describe('the editor’s questions', () => {
  it('names the action already on a key, so the move can be refused', () => {
    expect(conflictWith('mute', 'k')).toBe('playPause')
    expect(conflictWith('mute', 'q')).toBeNull()
  })

  it('doesn’t call an action a conflict with itself', () => {
    expect(conflictWith('mute', 'm')).toBeNull()
  })

  it('answers about the draft being edited, not the keys in force', () => {
    // The editor asks before anything is saved.
    expect(conflictWith('mute', 'x', { pin: 'x' })).toBe('pin')
    expect(conflictWith('mute', 'p', { pin: 'x' })).toBeNull()
  })

  it('shows a key the way the person pressed it', () => {
    expect(keyLabel('ArrowUp')).toBe('↑')
    expect(keyLabel('k')).toBe('K')
    expect(keyLabel(' ')).toBe('space')
    expect(keyLabel(',')).toBe(',')
  })
})
