/**
 * Whether a stream's chat shows who wrote each message.
 *
 * Names are most of a chat line's width, and over a busy stream they're mostly
 * noise: what's being said is the point, not by whom. Off, each line is just
 * the message (and a Super Chat's amount).
 *
 * One switch for every place the chat shows — the panel's tab and the chat
 * floating over the video — so the two never disagree. A preference, kept in
 * this browser and followed by its other tabs, like focus mode.
 */
import { useSyncExternalStore } from 'react'

export const CHAT_NAMES_KEY = 'ytfeed:chat-names'

function load(): boolean {
  try { return localStorage.getItem(CHAT_NAMES_KEY) !== '0' } catch { return true }
}

let shown = load()
const listeners = new Set<() => void>()

function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
function getSnapshot(): boolean { return shown }

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === CHAT_NAMES_KEY) { shown = load(); listeners.forEach((l) => l()) }
  })
}

/** React hook: whether chat lines carry their author's name. */
export function useChatNames(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function setChatNames(next: boolean) {
  if (shown === next) return
  shown = next
  try { localStorage.setItem(CHAT_NAMES_KEY, next ? '1' : '0') } catch { /* this visit only */ }
  listeners.forEach((l) => l())
}
