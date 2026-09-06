/**
 * FOCUS MODE: the control bar follows the cursor, and nothing else.
 *
 * Ordinarily the bar has three ways up — the pointer moving over the video, the
 * video not playing, and any shortcut key (a keypress is evidence you're there,
 * which in fullscreen is the only evidence there is). That last one is why the
 * bar keeps appearing over a video you're only listening to and steering by
 * keyboard: every `k`, every arrow, paints the bar back over the picture.
 *
 * Focus mode drops the other two and keeps the pointer. Move the mouse over the
 * video and the bar is there; do anything else — pause, seek, skip — and the
 * picture stays clean. The overlays that answer a keypress directly (the volume
 * HUD, the bookmark flash, captions) are untouched: those ARE the feedback for
 * what you just pressed, and hiding them would leave the key doing nothing
 * visible at all.
 *
 * A preference rather than a mode you re-arm: it's about how you watch, so it
 * persists and follows you to the next video, like the volume does.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'yt-feed-focus-mode-v1'

function load(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

let on = load()
const listeners = new Set<() => void>()

function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
function getSnapshot(): boolean { return on }

// Other tabs get the same answer — it's a preference, not a per-page state.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) { on = load(); listeners.forEach((l) => l()) }
  })
}

/** React hook: whether the bar should follow the cursor and nothing else. */
export function useFocusMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function setFocusMode(next: boolean) {
  if (on === next) return
  on = next
  try { localStorage.setItem(KEY, next ? '1' : '0') } catch { /* ignore */ }
  listeners.forEach((l) => l())
}
