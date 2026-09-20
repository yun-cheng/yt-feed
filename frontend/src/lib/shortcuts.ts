/**
 * The player's keyboard shortcuts, and the keys you've put them on.
 *
 * Every shortcut in the app is one row of ACTIONS: an id the handlers switch
 * on, the key it ships on, and a label for the settings page. A handler asks
 * `actionFor(e.key)` instead of comparing letters, so rebinding a key is one
 * stored override rather than an edit in three files — `WatchPage` (the embed),
 * `LocalWatchPage` (a file on disk) and `PlayerMarks` (bookmarks and A–B
 * repeat) all read the same table.
 *
 * Overrides are the `shortcuts` setting: a map of id → key holding ONLY what
 * you changed, so a default that moves later moves for everyone who never
 * touched it. Installed at startup by DefaultsLoader and again when Settings
 * saves, the same way the caption defaults are.
 *
 * Two keys are not in the table and cannot be rebound: `space` also plays and
 * pauses (it is what every player does, and the handlers take it by `e.code` so
 * it works whatever `playPause` is bound to), and `Escape` closes what's open.
 *
 * An override of `''` is an action with NO key — a shortcut you took away
 * rather than moved. It has to be storable, because "off" is a different
 * intention from "back on its default", and the only way to say it otherwise
 * would be to park the action on a key you promise never to press.
 */

export type ActionId =
  | 'playPause' | 'mute' | 'fullscreen' | 'captions' | 'pin'
  | 'volumeUp' | 'volumeDown'
  | 'back5' | 'forward5' | 'back10' | 'forward10'
  | 'speedDown' | 'speedUp'
  | 'bookmark' | 'loopStart' | 'loopEnd' | 'loopClear'

export type Action = {
  id: ActionId
  /** The key it ships on, as `e.key` writes it (already normalised). */
  key: string
  /** English, translated at render — listed in locales/dynamic.ts. */
  label: string
  /** Which group the settings page lists it under. */
  group: 'Playback' | 'Marks'
}

export const ACTIONS: readonly Action[] = [
  { id: 'playPause', key: 'k', label: 'Play / pause', group: 'Playback' },
  { id: 'mute', key: 'm', label: 'Mute', group: 'Playback' },
  { id: 'fullscreen', key: 'f', label: 'Fullscreen', group: 'Playback' },
  { id: 'captions', key: 'c', label: 'Captions on / off', group: 'Playback' },
  { id: 'pin', key: 'p', label: 'Pin the player', group: 'Playback' },
  { id: 'volumeUp', key: 'ArrowUp', label: 'Volume up', group: 'Playback' },
  { id: 'volumeDown', key: 'ArrowDown', label: 'Volume down', group: 'Playback' },
  { id: 'back5', key: 'ArrowLeft', label: 'Back 5 seconds', group: 'Playback' },
  { id: 'forward5', key: 'ArrowRight', label: 'Forward 5 seconds', group: 'Playback' },
  { id: 'back10', key: 'j', label: 'Back 10 seconds', group: 'Playback' },
  { id: 'forward10', key: 'l', label: 'Forward 10 seconds', group: 'Playback' },
  { id: 'speedDown', key: ',', label: 'Slower', group: 'Playback' },
  { id: 'speedUp', key: '.', label: 'Faster', group: 'Playback' },
  { id: 'bookmark', key: 'b', label: 'Bookmark this moment', group: 'Marks' },
  { id: 'loopStart', key: '[', label: 'Passage: pin the start', group: 'Marks' },
  { id: 'loopEnd', key: ']', label: 'Passage: pin the end', group: 'Marks' },
  { id: 'loopClear', key: '\\', label: 'Stop repeating', group: 'Marks' },
]

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]))

// A shifted key and the key under it are the same key. Someone who has just
// typed a capital and reaches for `,` sends `<`, which is a slip rather than a
// different intention — and `[`/`]`/`\` sit under the three brackets the same
// way. Applied to what the editor records as well, so a shortcut can only ever
// be stored as the unshifted key.
const UNSHIFTED: Record<string, string> = {
  '<': ',', '>': '.', '{': '[', '}': ']', '|': '\\',
}

/** One key, as the table stores it: lower case, and unshifted where the pair is
 *  one physical key. Anything longer than a character ('ArrowUp', 'Enter') is
 *  already canonical. */
export function normalizeKey(key: string): string {
  if (UNSHIFTED[key]) return UNSHIFTED[key]
  return key.length === 1 ? key.toLowerCase() : key
}

let overrides: Record<string, string> = {}

/** Install the stored `shortcuts` setting. Anything unrecognised — a key of the
 *  wrong shape, an action since renamed — is dropped rather than allowed to
 *  shadow a working default. `''` is kept: it means the action has no key. */
export function setShortcutOverrides(value: unknown) {
  const next: Record<string, string> = {}
  if (value && typeof value === 'object') {
    for (const [id, key] of Object.entries(value as Record<string, unknown>)) {
      if (BY_ID.has(id as ActionId) && typeof key === 'string') {
        next[id] = key ? normalizeKey(key) : ''
      }
    }
  }
  overrides = next
}

/** What's stored: only the actions you moved. */
export function shortcutOverrides(): Record<string, string> { return { ...overrides } }

/** The key this action is on — yours if you moved it, otherwise the default.
 *  `within` is for the settings editor, which asks about a draft map it hasn't
 *  saved yet rather than about the bindings currently in force. */
export function keyFor(id: ActionId, within: Record<string, string> = overrides): string {
  return within[id] ?? BY_ID.get(id)?.key ?? ''
}

/** The action a keypress means, or null for a key that means nothing.
 *
 *  Built per call rather than cached: it's a handful of entries walked once per
 *  keypress, and a cache would be one more thing to invalidate when the setting
 *  changes under a page that's already open. */
export function actionFor(key: string, within: Record<string, string> = overrides): ActionId | null {
  const k = normalizeKey(key)
  if (!k) return null  // an action with no key answers to nothing, not to ''
  for (const a of ACTIONS) if (keyFor(a.id, within) === k) return a.id
  return null
}

/** The action already on this key, if it isn't the one being rebound. The
 *  editor refuses a move onto a taken key: silently stealing it would leave the
 *  robbed action with no key at all and nothing to say so. */
export function conflictWith(
  id: ActionId, key: string, within: Record<string, string> = overrides,
): ActionId | null {
  const found = actionFor(key, within)
  return found && found !== id ? found : null
}

// How keys read in a tooltip or on the settings page. The arrows and the space
// bar have no printable form, and "ArrowUp" in a tooltip is the internal name
// leaking out.
const KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  ' ': 'space', Escape: 'esc', Enter: '⏎', Tab: '⇥', Backspace: '⌫',
}

/** What an action with no key shows — in the editor, and in the place a
 *  tooltip would otherwise name the key. A dash rather than nothing: the slot
 *  is still there, and "Play ()" reads as a bug. */
export const NO_KEY = '—'

/** One key, the way it should be shown to the person who pressed it. */
export function keyLabel(key: string): string {
  if (!key) return NO_KEY
  return KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key)
}

/** The label for an action's current key — what the player's tooltips carry. */
export function shortcutLabel(id: ActionId): string {
  return keyLabel(keyFor(id))
}
