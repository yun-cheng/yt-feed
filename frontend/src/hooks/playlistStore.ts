/**
 * Which playlists each video is saved in — the card's playlist badge.
 *
 * A global store for the same reason as summaryStore: the badge belongs to the
 * card, and cards are drawn by eight pages. One map for the whole library,
 * fetched once and again whenever something fires `playlists-changed` (the
 * save-to menu, a playlist page's remove and undo, an import).
 */
import { useSyncExternalStore } from 'react'
import { apiFetch } from '../lib/api'

export type PlaylistRef = { id: number; name: string }

let memberships: Record<string, PlaylistRef[]> = {}
const listeners = new Set<() => void>()
let listening = false

function emit(next: Record<string, PlaylistRef[]>) {
  memberships = next
  listeners.forEach((l) => l())
}

/** Fetch the map. Called once from App, and on every `playlists-changed`. */
export async function loadPlaylistMemberships(): Promise<void> {
  if (!listening) {
    listening = true
    window.addEventListener('playlists-changed', () => { loadPlaylistMemberships() })
  }
  try {
    const res = await apiFetch('/api/playlists/memberships', { quiet: true })
    if (res.ok) emit(await res.json())
  } catch { /* offline — badges hold their last known value */ }
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function usePlaylistsOf(videoId: string): PlaylistRef[] | undefined {
  return useSyncExternalStore(subscribe, () => memberships[videoId], () => memberships[videoId])
}

/** Tests only: forget the map between cases. */
export function _resetPlaylistMemberships(): void {
  emit({})
}
