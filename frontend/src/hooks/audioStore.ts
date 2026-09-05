/**
 * Global VOLUME shared by every video preview (feed, channel pages, anywhere
 * VideoCard is used) and persisted across refreshes.
 *
 * There is intentionally NO global mute state. Previews ALWAYS start muted —
 * muted autoplay is the only kind browsers reliably allow — and unmuting is a
 * PER-VIDEO action: clicking the preview unmutes just that video. A real click
 * is the user gesture the autoplay policy requires, so unmuting inside the click
 * is reliable (no stuck buffering, no audio-refetch spinner). Each card owns its
 * own mute state; there's nothing global to sync or persist for mute.
 *
 * Volume, on the other hand, is shared and persisted: a tiny external store read
 * via useSyncExternalStore, so changing it on one preview updates them all.
 *
 * Every value that lands here is SNAPPED to a multiple of VOLUME_STEP. The three
 * ways volume moves — a slider drag, the arrow keys, and the embed's own control
 * mirrored back — otherwise land on 48 or 49, which is a distinction no one can
 * hear and a number nobody meant. Snapping in the store rather than at each
 * control keeps the value the same wherever it came from.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'yt-feed-audio-v1'

/** The grain of the volume: the sliders step by it and every set snaps to it. */
export const VOLUME_STEP = 5

function snap(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v / VOLUME_STEP) * VOLUME_STEP))
}

function loadVolume(): number {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw)
      if (typeof p.volume === 'number') return snap(p.volume)
    }
  } catch { /* ignore malformed storage */ }
  return 100
}

let volume = loadVolume()
const listeners = new Set<() => void>()

function emit() { listeners.forEach((l) => l()) }
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify({ volume })) } catch { /* ignore */ }
}

// Keep tabs in sync on volume changes.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) { volume = loadVolume(); emit() }
  })
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
function getSnapshot(): number { return volume }

/** React hook: current shared volume (0–100). */
export function useVolume(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function setAudioVolume(v: number) {
  const next = snap(v)
  if (volume === next) return
  volume = next
  persist(); emit()
}
