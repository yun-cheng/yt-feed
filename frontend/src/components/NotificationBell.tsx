import { useEffect, useRef, useState } from 'react'
import {
  useNotifications, markAllRead, dismissNotification, clearNotifications,
} from '../hooks/notificationStore'
import type { Notification } from '../hooks/notificationStore'

/**
 * The bell, top right of every page's TopBar.
 *
 * Opening it marks everything read — the badge means "new since you looked",
 * and there is nothing to look at here but the list itself, so a separate
 * per-row read action would only be a second click for the same information.
 * The rows stay until dismissed, which is the part a toast can't do.
 */

/** Server timestamps are naive UTC; the Z is what stops them reading as local. */
function ago(iso: string | null): string {
  if (!iso) return ''
  const then = new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime()
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function iconFor(kind: string) {
  if (kind === 'summary_error') {
    return (
      <svg className="h-4 w-4 flex-shrink-0 text-[#f2a0a0]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
    )
  }
  return (
    <svg className="h-4 w-4 flex-shrink-0 text-[#8ab4f8]" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l1.9 5.2L19 9l-5.1 1.8L12 16l-1.9-5.2L5 9l5.1-1.8L12 2z" />
      <path d="M18.5 14l.85 2.3 2.15.7-2.15.7-.85 2.3-.85-2.3-2.15-.7 2.15-.7.85-2.3z" />
    </svg>
  )
}

export default function NotificationBell() {
  const { items, unread } = useNotifications()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  function toggle() {
    setOpen((o) => {
      if (!o) markAllRead()
      return !o
    })
  }

  function activate(n: Notification) {
    setOpen(false)
    if (!n.video_id) return
    // The summary IS an Ask answer, so this opens the panel holding it rather
    // than the video's page with the reader left to find it.
    window.dispatchEvent(new CustomEvent('app:open-video', {
      detail: { videoId: n.video_id, panel: n.kind === 'summary' ? 'ask' : undefined },
    }))
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        className="relative rounded-full p-2 text-[#aaa] transition-colors hover:bg-white/10 hover:text-white"
        aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
        title="Notifications"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0a3 3 0 11-6 0m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute right-0.5 top-0.5 min-w-[16px] rounded-full bg-red-600 px-1 text-[10px] font-bold leading-4 text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[min(92vw,360px)] overflow-hidden rounded-xl bg-[#282828] shadow-2xl ring-1 ring-white/10">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
            <span className="text-sm font-medium text-white">Notifications</span>
            {items.length > 0 && (
              <button
                onClick={() => clearNotifications()}
                className="text-xs text-[#aaa] transition-colors hover:text-white"
              >
                Clear all
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-[#717171]">Nothing yet.</p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto">
              {items.map((n) => (
                <li key={n.id} className="group flex items-start gap-2 px-3 py-2.5 transition-colors hover:bg-white/5">
                  <button
                    onClick={() => activate(n)}
                    disabled={!n.video_id}
                    className="flex min-w-0 flex-1 items-start gap-2.5 text-left disabled:cursor-default"
                  >
                    {/* The cover, when the row is about a video — it identifies
                        which one faster than the title beside it does. Falls
                        back to the kind's icon, which is also what a row written
                        before covers existed gets. */}
                    {n.thumbnail_url ? (
                      <span className="relative mt-0.5 block w-20 flex-shrink-0 overflow-hidden rounded bg-black/40">
                        <img
                          src={n.thumbnail_url}
                          alt=""
                          loading="lazy"
                          className="aspect-video w-full object-cover"
                          onError={(e) => { e.currentTarget.style.visibility = 'hidden' }}
                        />
                        <span className="absolute bottom-0.5 left-0.5 rounded bg-black/75 p-0.5">
                          {iconFor(n.kind)}
                        </span>
                      </span>
                    ) : (
                      <span className="mt-0.5">{iconFor(n.kind)}</span>
                    )}
                    <span className="min-w-0">
                      <span className="block text-sm text-white">{n.title}</span>
                      <span className="block truncate text-xs text-[#aaa]">{n.body}</span>
                      <span className="block text-[11px] text-[#717171]">{ago(n.created_at)}</span>
                    </span>
                  </button>
                  <button
                    onClick={() => dismissNotification(n.id)}
                    aria-label="Dismiss notification"
                    className="mt-0.5 rounded-full p-1 text-[#717171] opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100 focus:opacity-100"
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
