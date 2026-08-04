/**
 * Marks on the play head: bookmarks and the A–B repeat loop.
 *
 * Both are driven from the keyboard while watching — `b` marks the moment,
 * `[` and `]` set the loop's ends, `\` clears it — so everything here hangs off
 * one window-level key handler, the same way the player's other shortcuts do.
 *
 *  - usePlayerMarks(), which owns the state, the shortcuts, and the loop tick
 *  - MarkTrack, the marks themselves, drawn along a time axis
 *  - EmbedMarkRail, which puts a MarkTrack on the YouTube embed's progress bar
 *  - MarksFlash, the one-line confirmation of what a keypress just did
 *
 * Marks belong ON the progress bar — that's the axis they're positions on, and
 * anywhere else makes you translate a timestamp back into a place in the video.
 * Over a file we play ourselves that's literally the bar (see LocalControls);
 * over the embed the bar lives inside the iframe, out of reach, so the rail is
 * laid over it at the same offset the embed draws its own scrubber at.
 *
 * It talks to the player through PlayerApi, so it works the same over a YouTube
 * embed, a downloaded file, or a local one.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { apiFetch } from '../lib/api'
import { formatTime } from '../lib/time'
import type { PlayerApi } from './LocalControls'

export type Bookmark = {
  id: number
  position_seconds: number
  note: string
}

export type Loop = { a: number | null; b: number | null }

// How close `b` has to land to an existing bookmark to mean "remove that one"
// rather than "add another". Wide enough that pressing it twice while playing
// undoes the first press, narrow enough that two marks a few seconds apart —
// the start and end of a short phrase — both survive.
const TOGGLE_TOLERANCE_SEC = 2

// The loop only takes effect once its ends make sense. Without the floor, a
// stray `]` right after `[` would pin the video to a single frame.
const MIN_LOOP_SEC = 0.5

const LOOP_TICK_MS = 200
const FLASH_MS = 1600

export function loopActive(loop: Loop): boolean {
  return loop.a !== null && loop.b !== null && loop.b - loop.a >= MIN_LOOP_SEC
}

/** Bookmarks + A–B repeat for one video, wired to the keyboard.
 *
 * `videoId` is whatever identifies the video to the backend — a YouTube id, or
 * a local video's id. Both are just strings to /api/bookmarks. */
export function usePlayerMarks(videoId: string, playerRef: RefObject<PlayerApi | null>) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [loop, setLoop] = useState<Loop>({ a: null, b: null })
  // A brief line confirming what a keypress just did — pressing `b` is otherwise
  // silent, and a shortcut you can't tell fired is a shortcut you stop trusting.
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimer = useRef<number | undefined>(undefined)
  const showFlash = useCallback((text: string) => {
    setFlash(text)
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS)
  }, [])
  useEffect(() => () => { if (flashTimer.current) window.clearTimeout(flashTimer.current) }, [])

  // The key handler is bound once and must see the current list; state alone
  // would leave it holding whatever was there when it was bound.
  const bookmarksRef = useRef<Bookmark[]>([])
  bookmarksRef.current = bookmarks

  useEffect(() => {
    setBookmarks([])
    setLoop({ a: null, b: null })  // a loop is about this sitting, not the video
    let cancelled = false
    apiFetch(`/api/bookmarks/${videoId}`, { quiet: true })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setBookmarks(Array.isArray(d) ? d : []) })
      .catch(() => { /* no bookmarks shown; adding one still works */ })
    return () => { cancelled = true }
  }, [videoId])

  const addBookmark = useCallback((at: number) => {
    // Show it immediately under a temporary id, then swap in the saved row: the
    // POST is a round-trip, and a mark that appears a beat after the keypress
    // reads as a dropped one.
    const temp: Bookmark = { id: -Date.now(), position_seconds: at, note: '' }
    setBookmarks((list) => [...list, temp].sort((x, y) => x.position_seconds - y.position_seconds))
    apiFetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId, position_seconds: at }),
    })
      .then((r) => r.json())
      .then((saved: Bookmark) => {
        if (!saved?.id) return
        setBookmarks((list) => list.map((b) => (b.id === temp.id ? saved : b)))
      })
      .catch(() => setBookmarks((list) => list.filter((b) => b.id !== temp.id)))
  }, [videoId])

  const removeBookmark = useCallback((id: number) => {
    setBookmarks((list) => list.filter((b) => b.id !== id))
    if (id < 0) return  // never reached the server; nothing to delete
    apiFetch(`/api/bookmarks/id/${id}`, { method: 'DELETE' }).catch(() => { /* gone from view either way */ })
  }, [])

  const clearLoop = useCallback(() => {
    setLoop({ a: null, b: null })
    showFlash('Loop cleared')
  }, [showFlash])

  // Send the play head back to A each time it reaches B. Runs on its own timer
  // rather than the caption tick, which only exists while captions are on.
  useEffect(() => {
    const { a, b } = loop
    if (!loopActive(loop) || a === null || b === null) return
    const id = window.setInterval(() => {
      const p = playerRef.current
      if (!p) return
      if (p.getCurrentTime() < b) return
      p.seekTo(a, true)
      // A loop ending at the very end of the video hits B as the video ENDS, and
      // seeking a finished player leaves it paused at A. Nudge it back to play.
      if (p.getPlayerState() !== 1) p.playVideo()
    }, LOOP_TICK_MS)
    return () => window.clearInterval(id)
  }, [loop, playerRef])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
        || (t instanceof HTMLElement && t.isContentEditable)) return
      const p = playerRef.current
      if (!p) return
      const k = e.key
      if (k === 'b') {
        e.preventDefault()
        const at = p.getCurrentTime()
        // Nearest first, so the press undoes the mark you actually meant when
        // two sit inside the tolerance.
        const hit = [...bookmarksRef.current]
          .sort((x, y) => Math.abs(x.position_seconds - at) - Math.abs(y.position_seconds - at))
          .find((bm) => Math.abs(bm.position_seconds - at) <= TOGGLE_TOLERANCE_SEC)
        if (hit) {
          removeBookmark(hit.id)
          showFlash(`Bookmark removed · ${formatTime(hit.position_seconds)}`)
        } else {
          addBookmark(at)
          showFlash(`Bookmarked · ${formatTime(at)}`)
        }
      } else if (k === '[' || k === ']') {
        e.preventDefault()
        const at = p.getCurrentTime()
        setLoop((cur) => {
          // Either end can be set first and either can be moved afterwards. The
          // loop simply stays inactive until the pair makes sense (see
          // loopActive), so neither key is ever a keypress that does nothing.
          const next: Loop = k === '[' ? { ...cur, a: at } : { ...cur, b: at }
          showFlash(`Loop ${k === '[' ? 'A' : 'B'} · ${formatTime(at)}`)
          return next
        })
      } else if (k === '\\') {
        e.preventDefault()
        clearLoop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playerRef, addBookmark, removeBookmark, clearLoop, showFlash])

  // Only what's displayed. Everything that CHANGES a mark is a keypress this
  // hook already handles, so there's nothing for a caller to drive.
  return { bookmarks, loop, flash }
}

/** The marks themselves, positioned along a time axis. Absolutely positioned, so
 *  the parent has to be `relative` and as wide as the track being marked: our own
 *  control bar puts this inside its track (LocalControls), the embed rail lays it
 *  over YouTube's.
 *
 *  Every mark is clickable and jumps to itself, which is the whole reason to see
 *  them on the bar. Only those few pixels take the pointer: on the embed the
 *  marks sit on top of YouTube's scrubber, and swallowing a click meant for it
 *  is the cost of being able to click a mark at all — paid at the handful of x
 *  positions you put one on, and nowhere else.
 *
 *  Marks are drawn solid, with a dark ring: they land on video, which can be any
 *  colour at all, and a white tick on a white frame is no mark. */
export function MarkTrack({ bookmarks, loop, duration, onSeek }: {
  bookmarks: Bookmark[]
  loop: Loop
  duration: number
  onSeek: (seconds: number) => void
}) {
  if (!duration) return null
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`
  const showLoop = loop.a !== null || loop.b !== null
  // A 3px tick is too thin to aim at, so each is centred in a wider invisible
  // hit area. `stopPropagation` on the press keeps our own control bar from also
  // treating it as a scrub — it sits inside that bar's drag handler.
  const hit = (key: string | number, at: number, label: string, mark: ReactNode) => (
    <button
      key={key}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onSeek(at) }}
      title={`${label} — jump to ${formatTime(at)}`}
      aria-label={`${label} at ${formatTime(at)}`}
      className="absolute top-1/2 h-4 w-3 -translate-x-1/2 -translate-y-1/2 cursor-pointer"
      style={{ left: pct(at) }}
    >
      {mark}
    </button>
  )
  return (
    <>
      {/* The looped span, drawn solid rather than as a wash — a translucent tint
          over the played portion is nearly invisible, and that's the half you
          look at most. It appears only once the loop is really running: a
          half-set loop paints nothing, since a colour bar covering the rest of
          the video would claim something is repeating when nothing is. The end
          caps show either way, so you can see which end you've pinned. */}
      {loopActive(loop) && (
        <div
          className="pointer-events-none absolute inset-y-0 bg-yellow-300 ring-1 ring-black/40"
          style={{ left: pct(loop.a!), right: `${100 - parseFloat(pct(loop.b!))}%` }}
        />
      )}
      {showLoop && [loop.a, loop.b].map((end, i) => end === null ? null : hit(
        `loop${i}`,
        end,
        i === 0 ? 'Loop start (A)' : 'Loop end (B)',
        <div className="pointer-events-none absolute top-1/2 h-3.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-sm bg-yellow-300 ring-1 ring-black/50" />
      ))}
      {bookmarks.map((b) => hit(
        b.id,
        b.position_seconds,
        'Bookmark (press b here to remove)',
        <div className="pointer-events-none absolute top-1/2 h-3.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-sm bg-white ring-1 ring-black/50" />
      ))}
    </>
  )
}

// Where the embed draws its own progress bar, measured: a CONSTANT distance up
// from the bottom of the player, not a share of its height — 73px at 560px wide,
// 74px at 800, ~78px at 1280. An earlier `max(10%, 4.6rem)` tracked the height
// instead and so drifted further out the bigger the window got (10% of a 1080px-
// tall player is 108px, half a control bar too high). 76px splits the measured
// range: a couple of pixels off at the extremes, and never more than that.
const EMBED_BAR_BOTTOM = '76px'
const EMBED_BAR_INSET = '1.5%'

/** A MarkTrack laid over the YouTube embed's progress bar.
 *
 *  Unlike our own bar, this one doesn't fade with the controls: the embed hides
 *  its bar a couple of seconds into playback, and a loop you can't see is one
 *  you forget is running. */
export function EmbedMarkRail({ bookmarks, loop, duration, onSeek }: {
  bookmarks: Bookmark[]
  loop: Loop
  duration: number
  onSeek: (seconds: number) => void
}) {
  if (!duration || (!bookmarks.length && loop.a === null && loop.b === null)) return null
  return (
    <div
      className="pointer-events-none absolute z-20"
      style={{ bottom: EMBED_BAR_BOTTOM, left: EMBED_BAR_INSET, right: EMBED_BAR_INSET }}
    >
      <div className="pointer-events-none relative h-1">
        <MarkTrack bookmarks={bookmarks} loop={loop} duration={duration} onSeek={onSeek} />
      </div>
    </div>
  )
}

/** What the last keypress did. A shortcut you can't tell fired is one you stop
 *  trusting — and now that the marks live on the bar, which the embed hides
 *  while playing, this is often the only acknowledgement you get. */
export function MarksFlash({ flash }: { flash: string | null }) {
  if (!flash) return null
  return (
    <div className="pointer-events-none absolute left-4 top-4 z-20 rounded-full bg-black/75 px-3 py-1.5 text-sm font-medium text-white shadow-lg">
      {flash}
    </div>
  )
}
