/**
 * Each video's labels and fields — the card's badges for them, beside Watched.
 *
 * A global store for the same reason as playlistStore: cards are drawn by
 * eight pages. One map for the whole library (`GET /api/notes`), fetched once
 * from App; the Notes tab writes each save's answer straight back, so a card
 * shows what was just written without asking again.
 */
import { useSyncExternalStore } from 'react'
import { apiFetch } from '../lib/api'

export type CardNotes = { labels: string[]; fields: { name: string; values: string[] }[] }

let notes: Record<string, CardNotes> = {}
const listeners = new Set<() => void>()

function emit(next: Record<string, CardNotes>) {
  notes = next
  listeners.forEach((l) => l())
}

/** Fetch the map. Called once from App. */
export async function loadCardNotes(): Promise<void> {
  try {
    const res = await apiFetch('/api/notes', { quiet: true })
    if (res.ok) emit(await res.json())
  } catch { /* offline — cards keep what they had */ }
}

/** What the Notes tab just saved for this video, as the server kept it. */
export function rememberNotes(videoId: string, saved: CardNotes): void {
  const fields = saved.fields.filter((f) => f.values.length)
  const { [videoId]: _old, ...rest } = notes
  emit(saved.labels.length || fields.length
    ? { ...rest, [videoId]: { labels: saved.labels, fields } }
    : rest)
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useNotesOf(videoId: string): CardNotes | undefined {
  return useSyncExternalStore(subscribe, () => notes[videoId], () => notes[videoId])
}

/** Tests only: forget the map between cases. */
export function _resetCardNotes(): void {
  emit({})
}
