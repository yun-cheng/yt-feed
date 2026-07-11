/**
 * Global mute/volume state shared by every video preview (feed, channel pages,
 * anywhere VideoCard is used).
 *
 * Mute is SESSION-ONLY: every page load starts muted — browsers forbid sound
 * before the first interaction anyway, so persisting "unmuted" only produced
 * previews that claimed sound but couldn't deliver it. Unmuting once applies to
 * all previews until the next refresh. Volume persists across refreshes.
 *
 * A tiny external store read via useSyncExternalStore: changing it from one
 * card re-renders all mounted cards so their players stay in sync.
 */
import { useSyncExternalStore } from 'react'

export type AudioState = { muted: boolean; volume: number }

const KEY = 'yt-feed-audio-v1'

function loadVolume(): number {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw)
      if (typeof p.volume === 'number') return Math.max(0, Math.min(100, p.volume))
    }
  } catch { /* ignore malformed storage */ }
  return 100
}

let state: AudioState = { muted: true, volume: loadVolume() }
const listeners = new Set<() => void>()

function emit() { listeners.forEach((l) => l()) }
function persist() {
  // Only volume is persisted; mute is per-session (see header).
  try { localStorage.setItem(KEY, JSON.stringify({ volume: state.volume })) } catch { /* ignore */ }
}

// Keep tabs in sync too — volume only; each tab keeps its own session mute.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) { state = { muted: state.muted, volume: loadVolume() }; emit() }
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
