/**
 * A tiny global toast store — the app's single channel for surfacing
 * transient messages. Same useSyncExternalStore shape as audioStore: any
 * component can push a toast, and the one <Toaster/> renders them.
 *
 * Two kinds, and the difference is who has to act. An `error` reports what
 * already failed (see lib/api.ts) and only has to be read. An `undo` reports
 * something you just did that can be taken back, and carries the taking-back
 * with it — so the offer expires, and it expires sooner than an error does,
 * because an undo you come back to a minute later is an undo for a screen
 * you've left.
 */
import { useSyncExternalStore } from 'react'

export type Toast = {
  id: number
  message: string
  kind: 'error' | 'undo'
  /** Present on `undo`: what taking it back does. Runs at most once. */
  undo?: () => void
}

/** Long enough to read an error, and errors are click-dismissable. */
const ERROR_MS = 15000
/** Long enough to notice a mistake and reach the button, short enough that the
 *  offer belongs to the action you just took rather than to the page. */
export const UNDO_MS = 10000

let toasts: Toast[] = []
const listeners = new Set<() => void>()
let nextId = 1

function emit() {
  toasts = [...toasts]
  listeners.forEach((l) => l())
}

function push(toast: Toast, ms: number): number {
  toasts = [...toasts, toast]
  listeners.forEach((l) => l())
  if (typeof window !== 'undefined') window.setTimeout(() => dismissToast(toast.id), ms)
  return toast.id
}

export function pushToast(message: string, kind: Toast['kind'] = 'error'): number {
  return push({ id: nextId++, message, kind }, ERROR_MS)
}

/**
 * Say what just happened, and offer to take it back.
 *
 * `undo` is called on click and the toast goes; it never runs twice, because
 * the toast it lives on is gone by then. What it can't do is *wait* — the thing
 * has already happened by the time this is called, and undoing is a second
 * action that reverses it. A pause-then-commit would be a lie on a page that
 * can be closed, and closing the tab would take the pending delete with it.
 */
export function pushUndo(message: string, undo: () => void): number {
  return push({ id: nextId++, message, kind: 'undo', undo }, UNDO_MS)
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

/** Take back what the toast offers, and retire the offer. */
export function runUndo(id: number) {
  const toast = toasts.find((t) => t.id === id)
  if (!toast?.undo) return
  dismissToast(id)
  toast.undo()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts, () => toasts)
}
