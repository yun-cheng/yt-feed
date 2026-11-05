/**
 * A stream's chat floating over the video, for watching with it rather than
 * reading it: no times, no blur, little or no ground under it (each line
 * carries a shadow instead), and a box you put where the picture can spare it.
 *
 * Drag the strip along its top to move it; drag a lower corner to size it.
 * Both are kept as shares of the player (lib/chatOverlay), so the chat keeps
 * its place through a resize or fullscreen. The strip and the corners show
 * while the pointer is over the chat — and stay, where there's no pointer to
 * hover with.
 *
 * The chat itself is the panel's (`useChatReplay`, one fetch per page); this
 * is only another place to show it.
 */
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { ChatList, ChatNamesToggle, type ChatState } from './ChatReplay'
import { PANEL_UNIT } from './VideoPanel'
import { moveBox, nextBackdrop, resizeBox, type Backdrop, type ChatOverlayPrefs, type OverlayBox } from '../lib/chatOverlay'
import { t } from '../lib/i18n'

const GROUND: Record<Backdrop, string> = {
  none: '',
  light: 'bg-black/25',
  medium: 'bg-black/45',
}

const backdropLabel = (b: Backdrop) =>
  b === 'none' ? t('No background') : b === 'light' ? t('Light background') : t('Darker background')

const STRIP_BUTTON = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white'

// Shown while the pointer is over the chat, or while a drag is under way;
// always shown where nothing can hover (see `hoverable` in index.css).
const REVEAL = 'transition-opacity hoverable:opacity-0 hoverable:group-hover/chat:opacity-100'

type Drag = { kind: 'move' | 'sw' | 'se'; x: number; y: number; from: OverlayBox }

export default function ChatOverlay({ room, prefs, onPrefs, feed, time, duration, onSeek, syncButton, onDock, onClose }: {
  /** The player box: what position and size are shares of. */
  room: RefObject<HTMLElement | null>
  prefs: ChatOverlayPrefs
  onPrefs: (p: ChatOverlayPrefs) => void
  feed: { state: ChatState; retry: () => void }
  time: number
  duration: number
  onSeek: (seconds: number) => void
  syncButton: { className: string; icon: ReactNode }
  /** Back into the panel's Chat tab. */
  onDock: () => void
  onClose: () => void
}) {
  // The box while a drag is under way; written to `prefs` (and kept) when it ends.
  const [live, setLive] = useState<OverlayBox | null>(null)
  const drag = useRef<Drag | null>(null)
  const box = live ?? prefs

  // The drag is followed on the window, not on the handle: over the embed the
  // pointer is soon above YouTube's iframe, which takes every event after that
  // for itself — the drag would never hear the button come up. The shield
  // drawn below keeps the pointer in this page for as long as the drag lasts.
  // Listened for from the press itself rather than after the next render, so
  // a quick flick's first moves aren't lost.
  const latest = useRef({ prefs, onPrefs })
  latest.current = { prefs, onPrefs }
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])
  const dragging = live !== null

  const begin = (kind: Drag['kind']) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const from = { x: prefs.x, y: prefs.y, w: prefs.w, h: prefs.h }
    drag.current = { kind, x: e.clientX, y: e.clientY, from }
    let box: OverlayBox | null = null
    const move = (ev: PointerEvent) => {
      const d = drag.current
      const r = room.current?.getBoundingClientRect()
      if (!d || !r || !r.width || !r.height) return
      const dx = (ev.clientX - d.x) / r.width
      const dy = (ev.clientY - d.y) / r.height
      box = d.kind === 'move' ? moveBox(d.from, dx, dy) : resizeBox(d.from, d.kind, dx, dy)
      setLive(box)
    }
    const end = () => {
      stop.current?.()
      const { prefs: p, onPrefs: save } = latest.current
      if (box) save({ ...p, ...box })
      drag.current = null
      setLive(null)
    }
    stop.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      stop.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    setLive(from)
  }
  const handlers = (kind: Drag['kind']) => ({ onPointerDown: begin(kind) })

  const reveal = dragging ? '' : REVEAL

  return (
    <div
      data-testid="chat-overlay"
      // Clicks, double-clicks and drags here are the chat's: none of them
      // reach the player to pause it or go fullscreen.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`group/chat absolute z-20 flex flex-col rounded-lg text-white panel-type ${GROUND[prefs.backdrop]} ${dragging ? 'select-none ring-1 ring-white/40' : ''}`}
      style={{
        left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`,
        '--panel-unit': PANEL_UNIT,
      } as CSSProperties}
      role="complementary"
      aria-label={t('Chat on the video')}
    >
      <div className={`flex shrink-0 items-center gap-0.5 rounded-t-lg bg-black/40 px-1 py-0.5 ${reveal}`}>
        <div
          {...handlers('move')}
          title={t('Drag to move')}
          aria-label={t('Drag to move')}
          className="flex h-6 min-w-0 flex-1 cursor-move items-center gap-1.5 px-1 text-xs text-white/80 [touch-action:none]"
        >
          <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            {[6, 12, 18].flatMap((y) => [9, 15].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" />))}
          </svg>
          <span className="truncate">{t('Chat')}</span>
        </div>
        <button
          onClick={() => onPrefs({ ...prefs, backdrop: nextBackdrop(prefs.backdrop) })}
          aria-label={backdropLabel(prefs.backdrop)}
          title={backdropLabel(prefs.backdrop)}
          className={STRIP_BUTTON}
        >
          {/* A square, emptier for less ground under the chat. */}
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" fillOpacity={prefs.backdrop === 'none' ? 0 : prefs.backdrop === 'light' ? 0.35 : 0.75} />
          </svg>
        </button>
        <ChatNamesToggle className={STRIP_BUTTON} />
        <button onClick={onDock} aria-label={t('Back to the panel')} title={t('Back to the panel')} className={STRIP_BUTTON}>
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M15 4v16" />
          </svg>
        </button>
        <button onClick={onClose} aria-label={t('Close the chat')} title={t('Close the chat')} className={STRIP_BUTTON}>
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <ChatList feed={feed} time={time} duration={duration} onSeek={onSeek} syncButton={syncButton} showTime={false} onPicture />
      {/* Over everything while a drag lasts, the iframe included, so the
          pointer stays in this page; the cursor stays the handle's. */}
      {dragging && (
        <div
          aria-hidden
          className={`fixed inset-0 z-[100] ${drag.current?.kind === 'move' ? 'cursor-move' : drag.current?.kind === 'sw' ? 'cursor-nesw-resize' : 'cursor-nwse-resize'}`}
        />
      )}
      {(['sw', 'se'] as const).map((corner) => (
        <div
          key={corner}
          {...handlers(corner)}
          aria-label={t('Drag to resize')}
          title={t('Drag to resize')}
          className={`absolute bottom-0 h-4 w-4 [touch-action:none] ${corner === 'se' ? 'right-0 cursor-nwse-resize' : 'left-0 cursor-nesw-resize'} ${reveal}`}
        >
          <svg className={`h-4 w-4 text-white/70 ${corner === 'sw' ? '-scale-x-100' : ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
            <path strokeLinecap="round" d="M14 6L6 14M14 10l-4 4" />
          </svg>
        </div>
      ))}
    </div>
  )
}
