/**
 * The bell's store — what finished while you were elsewhere.
 *
 * Same useSyncExternalStore shape as toastStore, and deliberately NOT the same
 * thing: a toast belongs to the request that raised it and is gone in fifteen
 * seconds, while these are rows on the server that outlive the tab. Background
 * work needs the second kind, because by the time it finishes you are on
 * another page.
 *
 * Polls slowly on its own (a summary takes half a minute, nothing here is
 * urgent) and is refreshed on the spot by whoever knows something landed — see
 * summaryStore, which calls in the moment a job flips to done.
 */
import { useSyncExternalStore } from 'react'
import { apiFetch } from '../lib/api'

export type Notification = {
  id: number
  kind: string
  title: string
  body: string
  video_id: string
  thumbnail_url: string
  read: boolean
  created_at: string | null
}

type State = { items: Notification[]; unread: number }

let state: State = { items: [], unread: 0 }
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

// Slow on purpose. The one thing that produces notifications today already
// pokes us the moment it finishes, so this is the fallback for a job started in
// another tab — not the mechanism.
const POLL_MS = 60_000

function emit(next: State) {
  state = next
  listeners.forEach((l) => l())
}

export async function refreshNotifications(): Promise<void> {
  try {
    const res = await apiFetch('/api/notifications', { quiet: true })
    if (!res.ok) return
    const data = await res.json()
    emit({ items: data.notifications ?? [], unread: data.unread ?? 0 })
  } catch { /* offline — the badge just stays where it was */ }
}

/** Opening the bell reads everything in it: the badge is "new since you looked". */
export async function markAllRead(): Promise<void> {
  if (state.unread === 0) return
  emit({ items: state.items.map((n) => ({ ...n, read: true })), unread: 0 })
  await apiFetch('/api/notifications/read', { method: 'POST', quiet: true }).catch(() => {})
}

export async function dismissNotification(id: number): Promise<void> {
  const gone = state.items.find((n) => n.id === id)
  emit({
    items: state.items.filter((n) => n.id !== id),
    unread: Math.max(0, state.unread - (gone && !gone.read ? 1 : 0)),
  })
  await apiFetch(`/api/notifications/${id}`, { method: 'DELETE', quiet: true }).catch(() => {})
}

export async function clearNotifications(): Promise<void> {
  emit({ items: [], unread: 0 })
  await apiFetch('/api/notifications', { method: 'DELETE', quiet: true }).catch(() => {})
}

/** Called once from App. Idempotent, so StrictMode's double-mount is harmless. */
export function startNotificationPolling(): void {
  refreshNotifications()
  if (timer !== null) return
  timer = setInterval(refreshNotifications, POLL_MS)
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useNotifications(): State {
  return useSyncExternalStore(subscribe, () => state, () => state)
}
