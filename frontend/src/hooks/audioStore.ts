/**
 * Global mute/volume preference shared by every video preview (feed, channel
 * pages, anywhere VideoCard is used) and persisted across page refreshes.
 *
 * A tiny external store read via useSyncExternalStore: changing it from one
 * card re-renders all mounted cards so their players stay in sync.
 */
import { useSyncExternalStore } from 'react'

export type AudioState = { muted: boolean; volume: number }

const KEY = 'yt-feed-audio-v1'

function load(): AudioState {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw)
      const volume = typeof p.volume === 'number' ? Math.max(0, Math.min(100, p.volume)) : 100
      const muted = typeof p.muted === 'boolean' ? p.muted : true
      return { muted, volume }
    }
  } catch { /* ignore malformed storage */ }
  return { muted: true, volume: 100 } // videos autoplay muted by default
}

let state: AudioState = load()
const listeners = new Set<() => void>()

function emit() { listeners.forEach((l) => l()) }
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* ignore */ }
}

// Keep tabs in sync too — cheap and avoids a stale state after changing it elsewhere.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) { state = load(); emit() }
  })
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
function getSnapshot(): AudioState { return state }

/** React hook: current shared { muted, volume }. */
export function useAudio(): AudioState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function setAudioMuted(muted: boolean) {
  if (state.muted === muted) return
  state = { ...state, muted }
  persist(); emit()
}

export function setAudioVolume(volume: number) {
  const v = Math.max(0, Math.min(100, Math.round(volume)))
  if (state.volume === v) return
  state = { ...state, volume: v }
  persist(); emit()
}
