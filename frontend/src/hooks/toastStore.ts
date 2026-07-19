/**
 * A tiny global toast store — the app's single channel for surfacing
 * transient messages, today used for API errors (see lib/api.ts). Same
 * useSyncExternalStore shape as audioStore: any component can push a toast,
 * and the one <Toaster/> renders them.
 */
import { useSyncExternalStore } from 'react'

export type Toast = { id: number; message: string; kind: 'error' }

let toasts: Toast[] = []
const listeners = new Set<() => void>()
let nextId = 1

function emit() {
  toasts = [...toasts]
  listeners.forEach((l) => l())
}

export function pushToast(message: string, kind: Toast['kind'] = 'error'): number {
  const id = nextId++
  toasts = [...toasts, { id, message, kind }]
  listeners.forEach((l) => l())
  // Auto-dismiss; errors linger a little so they're readable.
  if (typeof window !== 'undefined') window.setTimeout(() => dismissToast(id), 6000)
  return id
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts, () => toasts)
}
