/**
 * Which videos have a long summary, and which are having one written.
 *
 * A global store rather than a prop, because the label belongs to the CARD and
 * cards are rendered by eight different pages — threading `summaryStatus`
 * through all of them to reach one badge would be a worse trade than a module
 * every card can read directly.
 *
 * Polling only exists while something is running. A finished library is a
 * static map, and asking the server about it on a timer would be traffic that
 * can never change its answer.
 */
import { useSyncExternalStore } from 'react'
import { apiFetch } from '../lib/api'
import { refreshNotifications } from './notificationStore'

export type SummaryStatus = 'running' | 'done' | 'error'
export type SummaryLength = 'short' | 'long'
/** What a card knows about its summary: how it went, and which one it was. */
export type SummaryState = { status: SummaryStatus; length: SummaryLength }

let statuses: Record<string, SummaryState> = {}
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null

// Fast enough that "Summarising" turning into "Summarised" feels like it
// happened when it happened, cheap enough to leave running for a minute.
const POLL_MS = 4_000

function emit(next: Record<string, SummaryState>) {
  statuses = next
  listeners.forEach((l) => l())
}

const anyRunning = (m: Record<string, SummaryState>) =>
  Object.values(m).some((s) => s.status === 'running')

async function fetchAll(): Promise<void> {
  try {
    const res = await apiFetch('/api/summaries', { quiet: true })
    if (!res.ok) return
    const data = await res.json()
    const next: Record<string, SummaryState> = {}
    for (const j of data.jobs ?? []) {
      next[j.video_id] = { status: j.status as SummaryStatus, length: j.length as SummaryLength }
    }
    // Something we were watching has landed — the bell has a new row for it,
    // and waiting out its own slow poll would show the badge a minute late.
    if (anyRunning(statuses) && !anyRunning(next)) refreshNotifications()
    emit(next)
  } catch { /* offline — labels hold their last known value */ }
}

function schedule() {
  if (timer !== null) return
  timer = setTimeout(async () => {
    timer = null
    await fetchAll()
    if (anyRunning(statuses)) schedule()
  }, POLL_MS)
}

/** Called once from App: the map every card reads, fetched before they render. */
export async function loadSummaries(): Promise<void> {
  await fetchAll()
  if (anyRunning(statuses)) schedule()
}

/**
 * Ask for a summary of this video, in one of the Ask panel's two lengths.
 *
 * Marks it running before the request goes out, so the card labels itself on
 * the click rather than on the round trip; the server's answer overwrites that
 * either way, including when it says a job was already in flight — which is
 * also how a click on the OTHER length while one is running corrects itself.
 */
export async function startSummary(videoId: string, length: SummaryLength = 'long'): Promise<void> {
  emit({ ...statuses, [videoId]: { status: 'running', length } })
  schedule()
  try {
    const res = await apiFetch(`/api/summaries/${videoId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ length }),
    })
    if (!res.ok) {
      const { [videoId]: _dropped, ...rest } = statuses
      emit(rest)
      return
    }
    const job = await res.json()
    emit({
      ...statuses,
      [videoId]: { status: job.status as SummaryStatus, length: job.length as SummaryLength },
    })
  } catch {
    const { [videoId]: _dropped, ...rest } = statuses
    emit(rest)
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useSummaryStatus(videoId: string): SummaryState | undefined {
  return useSyncExternalStore(subscribe, () => statuses[videoId], () => statuses[videoId])
}

/** Test seam — the stores are module state, which outlives a single test. */
export function _resetSummaries() {
  if (timer !== null) { clearTimeout(timer); timer = null }
  emit({})
}
