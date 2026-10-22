/**
 * The caption menu's two slots, Main and Second, as a pure rule: given the
 * row clicked and what each slot shows now, what each slot shows next. An
 * empty slot is off. WatchPage commits the pair (and keeps the invariant that
 * there's no Second without a Main).
 */
export type Slots = [main: string, second: string]

// Clicking a Main row: the active one toggles the slot off (promoting any
// second); a row already in the second slot moves up (clearing second);
// anything else becomes the new main — and the main it replaces drops into an
// empty Second rather than going off, so picking a translation keeps the
// original under it. A Second already chosen stays put.
export function pickMain(code: string, main: string, second: string): Slots {
  if (code === main) return [second, '']
  if (code === second) return [code, '']
  return [code, second || main]
}

// Clicking a Second row: the active one toggles off; picking the current main
// swaps the two; anything else becomes the new second.
export function pickSecond(code: string, main: string, second: string): Slots {
  if (code === second) return [main, '']
  if (code === main) return [second, code]
  return [main, code]
}
