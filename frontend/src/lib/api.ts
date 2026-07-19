/**
 * apiFetch — a drop-in replacement for fetch() that surfaces failures.
 *
 * It has the SAME signature and return type as fetch (resolves to a Response),
 * so call sites keep their existing `res.ok` / `res.json()` handling. The only
 * added behaviour: on a non-OK response or a network error it pushes an error
 * toast, so a failed request can never fail silently — even at the many call
 * sites that do `if (!res.ok) return` or `.catch(() => {})`.
 *
 * Pass `{ quiet: true }` for high-frequency background traffic (hover-preview
 * captions/storyboards, the topic-build poll) where a toast per failure would
 * just be noise and the feature already degrades gracefully.
 */
import { pushToast } from '../hooks/toastStore'

export type ApiInit = RequestInit & { quiet?: boolean }

function pathOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.pathname
  return (input as Request).url ?? String(input)
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase()
  if (typeof input !== 'string' && !(input instanceof URL)) {
    return (input as Request).method?.toUpperCase() ?? 'GET'
  }
  return 'GET'
}

/** Turn an error Response body into a short human message, if it has one. */
async function detailOf(res: Response): Promise<string> {
  try {
    const text = await res.clone().text()
    if (!text) return ''
    try {
      const json = JSON.parse(text)
      const d = json?.detail ?? json?.error ?? json?.message
      if (typeof d === 'string') return d
    } catch { /* not JSON — fall through to raw text */ }
    return text.length > 120 ? text.slice(0, 120) + '…' : text
  } catch {
    return ''
  }
}

export async function apiFetch(input: RequestInfo | URL, init: ApiInit = {}): Promise<Response> {
  const { quiet, ...rest } = init
  let res: Response
  try {
    res = await fetch(input, rest)
  } catch (err) {
    if (!quiet) pushToast(`${methodOf(input, rest)} ${pathOf(input)} — network error`)
    throw err
  }
  if (!res.ok && !quiet) {
    // Read the body off a clone so the caller's res.json()/res.text() still works.
    detailOf(res).then((detail) => {
      const where = `${methodOf(input, rest)} ${pathOf(input)}`
      pushToast(`${where} failed (${res.status})${detail ? `: ${detail}` : ''}`)
    })
  }
  return res
}
