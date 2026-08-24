/**
 * Marks on the play head: bookmarks and the A–B repeat loop.
 *
 * Both are driven from the keyboard while watching — `b` marks the moment,
 * `[` and `]` set the loop's ends, `\` clears it — so everything here hangs off
 * one window-level key handler, the same way the player's other shortcuts do.
 * The same actions come back out of the hook for the control bar's buttons: a
 * feature only a shortcut can reach is one you have to already know about.
 *
 *  - usePlayerMarks(), which owns the state, the shortcuts, and the loop tick
 *  - MarkTrack, the marks themselves, drawn along a time axis
 *  - EmbedMarkRail, which puts a MarkTrack on the YouTube embed's progress bar
 *  - MarksFlash, the one-line confirmation of what a keypress just did
 *
 * Marks belong ON the progress bar — that's the axis they're positions on, and
 * anywhere else makes you translate a timestamp back into a place in the video.
 * Bookmarks wear one colour everywhere they appear — the tick, the button that
 * made it, the line confirming the press — so those read as one thing. The loop
 * wears none: it restyles the bar rather than marking it (see below).
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

/**
 * The one colour a bookmark wears, everywhere it appears — the tick on the bar,
 * the button that made it, the dot on the line confirming the press.
 *
 * The player's own furniture is red (progress), white (track, buffered, the
 * scrub indicator) and black, and a mark of yours in any of those reads as part
 * of the bar rather than as something you put there — worst of all over the
 * embed, where it lands on YouTube's own near-white track. It keeps the dark
 * ring either way: these sit on video, which can be any colour at all.
 */
const BOOKMARK_COLOR = 'bg-sky-400'

// The loop gets no colour of its own, because it isn't a mark — it's a MODE the
// bar is in. So the bar says it: the stretch that repeats is the bar, and
// everything outside it is dimmed back. Nothing new is drawn over the track, the
// red fill and the thumb stay readable through the veil, and the loop can't
// clash with the player's own palette because it doesn't add to it.
const LOOP_DIM = 'bg-black/50'
// A cut through the track at each pinned end. Dark, like the gaps YouTube puts
// between chapters — a boundary in a bar reads as a break in it, not as a thing
// sitting on top of it.
const LOOP_EDGE = 'bg-black/70'

/** Nothing pinned / one end pinned / repeating. What the loop button reads. */
export type LoopStage = 'idle' | 'arming' | 'running'

/** A line confirming what the last press did, and which feature it was about —
 *  the dot on it is drawn in that feature's colour. */
export type Flash = { kind: 'bookmark' | 'loop'; text: string }

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

// How often we ask where the play head is, to know whether it's standing on a
// bookmark. Half a second against a 2s tolerance: the answer only changes as you
// cross a mark, and it's a boolean, so the poll costs a render only then.
const MARK_HERE_TICK_MS = 500

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
  const [flash, setFlash] = useState<Flash | null>(null)
  const flashTimer = useRef<number | undefined>(undefined)
  const showFlash = useCallback((kind: Flash['kind'], text: string) => {
    setFlash({ kind, text })
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS)
  }, [])
  useEffect(() => () => { if (flashTimer.current) window.clearTimeout(flashTimer.current) }, [])

  // The key handler is bound once and must see the current values; state alone
  // would leave it holding whatever was there when it was bound. The loop gets
  // the same treatment so the actions below can branch on it without doing the
  // branching inside a setState updater, which React is free to run twice.
  const bookmarksRef = useRef<Bookmark[]>([])
  bookmarksRef.current = bookmarks
  const loopRef = useRef<Loop>(loop)
  loopRef.current = loop

  // Whether the play head is standing on a bookmark — which is what decides
  // whether the bar's button adds one or clears the one that's there. The
  // position moves on its own, so this has to be watched rather than derived.
  const [markHere, setMarkHere] = useState(false)
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = playerRef.current
      const at = p?.getCurrentTime() ?? 0
      setMarkHere(Boolean(p) && bookmarksRef.current.some((b) => Math.abs(b.position_seconds - at) <= TOGGLE_TOLERANCE_SEC))
    }, MARK_HERE_TICK_MS)
    return () => window.clearInterval(id)
  }, [playerRef])

  useEffect(() => {
    setBookmarks([])
    setLoop({ a: null, b: null })  // a loop is about this sitting, not the video
    // Cleared with the marks rather than left to the next poll: half a second of
    // a button offering to clear a bookmark the new video hasn't got is half a
    // second of it lying.
    setMarkHere(false)
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
    showFlash('loop', 'Loop cleared')
  }, [showFlash])

  // The three things a keypress or a button press can do, in one place so the
  // two ways of asking behave identically.

  /** Bookmark this moment — or drop the one already here (see TOGGLE_TOLERANCE_SEC). */
  const toggleBookmarkAt = useCallback((at: number) => {
    // Nearest first, so the press undoes the mark you actually meant when two
    // sit inside the tolerance.
    const hit = [...bookmarksRef.current]
      .sort((x, y) => Math.abs(x.position_seconds - at) - Math.abs(y.position_seconds - at))
      .find((bm) => Math.abs(bm.position_seconds - at) <= TOGGLE_TOLERANCE_SEC)
    if (hit) {
      removeBookmark(hit.id)
      showFlash('bookmark', `Bookmark removed · ${formatTime(hit.position_seconds)}`)
    } else {
      addBookmark(at)
      showFlash('bookmark', `Bookmarked · ${formatTime(at)}`)
    }
    // Ahead of the poll: a button that stays on "remove" for half a second after
    // it removed something reads as a press that didn't take.
    setMarkHere(!hit)
  }, [addBookmark, removeBookmark, showFlash])

  /** Pin one end of the loop here. Either end can be set first and either can be
   *  moved afterwards; the loop simply stays inactive until the pair makes sense
   *  (see loopActive), so neither key is ever a keypress that does nothing. */
  const setLoopEnd = useCallback((end: 'a' | 'b', at: number) => {
    setLoop((cur) => ({ ...cur, [end]: at }))
    showFlash('loop', `Loop ${end.toUpperCase()} · ${formatTime(at)}`)
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
        toggleBookmarkAt(p.getCurrentTime())
      } else if (k === '[' || k === ']') {
        e.preventDefault()
        setLoopEnd(k === '[' ? 'a' : 'b', p.getCurrentTime())
      } else if (k === '\\') {
        e.preventDefault()
        clearLoop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playerRef, toggleBookmarkAt, setLoopEnd, clearLoop])

  // How far along the loop is, for anything drawing a button for it: nothing
  // pinned, one end pinned, or running. Named here rather than re-derived by
  // each caller, so the button and cycleLoop below can never disagree about
  // which press does what.
  const loopStage: LoopStage = loopActive(loop) ? 'running' : (loop.a !== null || loop.b !== null) ? 'arming' : 'idle'

  /** The whole A–B loop from one button: set an end, set the other, clear.
   *
   *  Three keys collapse into one press because a button has one obvious next
   *  thing to do at each stage, and the stage is on its face. The keyboard keeps
   *  the finer control — `[` and `]` move either end whenever you like. */
  const cycleLoop = useCallback(() => {
    const p = playerRef.current
    if (!p) return
    const cur = loopRef.current
    if (loopActive(cur)) clearLoop()
    else setLoopEnd(cur.a === null ? 'a' : 'b', p.getCurrentTime())
  }, [playerRef, clearLoop, setLoopEnd])

  /** Bookmark (or clear) wherever the play head is, for the bar's button — the
   *  keyboard's `b` with the position read for you. Clicking a mark on the track
   *  seeks exactly to it, so that plus this button is how one gets cleared
   *  without hunting for the moment by hand. */
  const toggleBookmarkHere = useCallback(() => {
    const p = playerRef.current
    if (p) toggleBookmarkAt(p.getCurrentTime())
  }, [playerRef, toggleBookmarkAt])

  return { bookmarks, loop, loopStage, markHere, flash, toggleBookmarkHere, cycleLoop, clearLoop }
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
 *  colour at all, and a bright tick on a bright frame is no mark.
 *
 *  A bookmark is a POINT and a loop is a MODE, so only one of them is a mark. The
 *  bookmark is a tick standing in the track it's a position on. The loop is the
 *  bar itself: its ends cut the track, and once it's really running everything
 *  outside it dims back, leaving the repeating stretch as the only part at full
 *  strength. Nothing is added over the bar for it — no second colour to place
 *  against the player's red and white, and the fill and thumb read straight
 *  through the veil. */
export function MarkTrack({ bookmarks, loop, duration, onSeek }: {
  bookmarks: Bookmark[]
  loop: Loop
  duration: number
  onSeek: (seconds: number) => void
}) {
  if (!duration) return null
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`
  const showLoop = loop.a !== null || loop.b !== null
  // A tick is narrower than anything is comfortable to aim at, so each sits in a
  // wider invisible hit area. `stopPropagation` on the press keeps our own
  // control bar from also treating it as a scrub — it sits inside that bar's
  // drag handler.
  //
  // That hit area is also the "you're near it" zone: `group/mark` lets the tick
  // grow inside it, the way the track thickens under the pointer. What grows is
  // the tick, not the target — over the embed these sit on YouTube's own
  // scrubber, and every pixel of hit area is a pixel of its bar we've taken.
  //
  // Anything drawn INSIDE must carry `left-1/2` of its own. Without it the
  // browser lays it out at its static position — the hit area's LEFT EDGE — and
  // the -translate-x-1/2 then centres it on that edge, drawing the mark 6px (half
  // the hit area) earlier than the moment it stands for.
  const hit = (key: string | number, at: number, label: string, mark: ReactNode) => (
    <button
      key={key}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onSeek(at) }}
      title={`${label} — jump to ${formatTime(at)}`}
      aria-label={`${label} at ${formatTime(at)}`}
      className="group/mark absolute top-1/2 h-4 w-3 -translate-x-1/2 -translate-y-1/2 cursor-pointer"
      style={{ left: pct(at) }}
    >
      {mark}
    </button>
  )
  return (
    <>
      {/* Outside the loop, dimmed — the loop is the part of the bar still at full
          strength. Only once it's really running: a dim covering the rest of the
          video would claim something repeats when nothing does.

          It veils the fill along with the track, which is the point — the played
          portion outside the loop is exactly the part you're no longer watching.
          The thumb is drawn after this, so the play head stays bright wherever
          it is, and so do any bookmarks: those aren't the loop's business. */}
      {loopActive(loop) && (
        <>
          <div
            data-testid="loop-dim"
            className={`pointer-events-none absolute inset-y-0 left-0 rounded-l-full ${LOOP_DIM}`}
            style={{ width: pct(loop.a!) }}
          />
          <div
            data-testid="loop-dim"
            className={`pointer-events-none absolute inset-y-0 right-0 rounded-r-full ${LOOP_DIM}`}
            style={{ left: pct(loop.b!) }}
          />
        </>
      )}
      {/* Each pinned end cuts the track. Shown from the first press, when there's
          nothing to dim yet — a notch claims only "you pinned this moment",
          which is all that's true until the pair makes sense. */}
      {[loop.a, loop.b].map((end, i) => end === null ? null : (
        <div
          key={`edge${i}`}
          data-testid="loop-edge"
          className={`pointer-events-none absolute inset-y-0 w-[2px] -translate-x-1/2 ${LOOP_EDGE}`}
          style={{ left: pct(end) }}
        />
      ))}
      {/* The ends are clickable like any other mark, but the notch above IS the
          mark — this is the hit area over it, and has nothing of its own to
          draw. */}
      {showLoop && [loop.a, loop.b].map((end, i) => end === null ? null : hit(
        `loop${i}`,
        end,
        i === 0 ? 'Loop start (A)' : 'Loop end (B)',
        null
      ))}
      {bookmarks.map((b) => hit(
        b.id,
        b.position_seconds,
        'Bookmark',
        // Grows on approach rather than on a direct hit: by the time the
        // pointer is within the hit area you've already committed to this mark,
        // and a tick that answers is one you can tell you'll actually land.
        <div className={`pointer-events-none absolute left-1/2 top-1/2 h-3.5 w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-sm ${BOOKMARK_COLOR} ring-1 ring-black/50 transition-all duration-100 group-hover/mark:h-[18px] group-hover/mark:w-[8px]`} />
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
export function MarksFlash({ flash }: { flash: Flash | null }) {
  if (!flash) return null
  return (
    <div className="pointer-events-none absolute left-4 top-4 z-20 flex items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 text-sm font-medium text-white shadow-lg">
      {/* Which feature just spoke: a bookmark in its own colour, the loop in the
          bar's own white, since that's all the loop ever wears. */}
      <span className={`h-2 w-2 shrink-0 rounded-full ${flash.kind === 'loop' ? 'bg-white/70' : BOOKMARK_COLOR}`} />
      {flash.text}
    </div>
  )
}
