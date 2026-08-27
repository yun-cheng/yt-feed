/**
 * Marks on the play head: bookmarks, and the passages set to repeat.
 *
 * Both are driven from the keyboard while watching — `b` marks the moment,
 * `[` and `]` set the ends of the passage that's repeating, `\` stops it — so
 * everything here hangs off one window-level key handler, the same way the
 * player's other shortcuts do. Both are kept server-side per video, so the
 * passage you were working on is still the passage when you come back to it
 * (see /api/bookmarks). The same actions come back out of the hook for the
 * control bar's buttons: a feature only a shortcut can reach is one you have to
 * already know about.
 *
 *  - usePlayerMarks(), which owns the state, the shortcuts, and the loop tick
 *  - LoopMenu, the video's saved passages and everything you can do to one
 *  - MarkTrack, the marks themselves, drawn along a time axis
 *  - EmbedMarkRail, which puts a MarkTrack on the YouTube embed's progress bar
 *  - MarksFlash, the one-line confirmation of what a keypress just did
 *
 * Marks belong ON the progress bar — that's the axis they're positions on, and
 * anywhere else makes you translate a timestamp back into a place in the video.
 * Bookmarks wear one colour everywhere they appear — the tick, the button that
 * made it, the line confirming the press — so those read as one thing. The loop
 * wears none: it restyles the bar rather than marking it (see below), which is
 * also why only the running passage dims and the rest are cuts alone.
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

/** Where a repeat runs from and to. Either end may be unpinned. */
export type Loop = { a: number | null; b: number | null }

/** One saved passage of a video: a loop with a name to be called by.
 *
 *  `active` is the whole difference between this and a bookmark. A bookmark is a
 *  POINT, so marks simply coexist; a loop is a MODE, so a video can hold several
 *  passages but only one of them repeats — and which one is worth remembering,
 *  since that's the passage you were working on. */
export type SavedLoop = { id: number; a: number | null; b: number | null; active: boolean }

const NO_LOOP: Loop = { a: null, b: null }

/** How a passage reads in the menu. Unpinned ends say what they resolve to,
 *  because that's what the repeat actually does. */
export function loopLabel(loop: Loop): string {
  return `${loop.a === null ? 'start' : formatTime(loop.a)} – ${loop.b === null ? 'end' : formatTime(loop.b)}`
}

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
// A passage that's saved but not running gets the same cut, half as dark. It's
// still a boundary in the bar rather than a thing on top of it — just a quieter
// one, because it isn't what's happening right now. Only the running passage
// dims, so several saved ones can't turn the bar into a ladder of veils.
const LOOP_EDGE_IDLE = 'bg-black/35'

/** How far along the pinning is on the passage that's running: nothing pinned,
 *  one end pinned, both. What the loop button's badge reads. */
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

/** Where the loop actually runs from and to, or null if it can't run.
 *
 *  One end is enough. An unpinned A means the start of the video and an unpinned
 *  B means the end of it, which is what the two keys read as on their own: `[`
 *  alone is "repeat from here", `]` alone is "repeat up to here". Pressing one
 *  and then having to press the other before anything happens made the first
 *  press a keystroke that did nothing.
 *
 *  `duration` is what an unpinned B resolves to, so a player that doesn't know
 *  the length yet reports 0 and the loop simply doesn't run until it does. */
export function loopBounds(loop: Loop, duration: number): { a: number; b: number } | null {
  if (loop.a === null && loop.b === null) return null
  const a = loop.a ?? 0
  const b = loop.b ?? duration
  return b - a >= MIN_LOOP_SEC ? { a, b } : null
}

export function loopActive(loop: Loop, duration: number): boolean {
  return loopBounds(loop, duration) !== null
}

/** Bookmarks + A–B repeat for one video, wired to the keyboard.
 *
 * `videoId` is whatever identifies the video to the backend — a YouTube id, or
 * a local video's id. Both are just strings to /api/bookmarks. */
export function usePlayerMarks(videoId: string, playerRef: RefObject<PlayerApi | null>) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  // Every passage marked in this video, oldest first. At most one is active —
  // the router holds that invariant, and so does every write below.
  const [loops, setLoops] = useState<SavedLoop[]>([])
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
  const loopsRef = useRef<SavedLoop[]>([])
  loopsRef.current = loops

  // The passage that's running, and its ends on their own — which is all the
  // bar and the tick need, and all they ever needed.
  const activeLoop = loops.find((l) => l.active) ?? null
  const loop: Loop = activeLoop ? { a: activeLoop.a, b: activeLoop.b } : NO_LOOP
  // And the rest, for the bar to cut quietly. Passages you marked but aren't on.
  const others: Loop[] = loops.filter((l) => !l.active).map((l) => ({ a: l.a, b: l.b }))

  // Whether the play head is standing on a bookmark — which is what decides
  // whether the bar's button adds one or clears the one that's there. The
  // position moves on its own, so this has to be watched rather than derived.
  const [markHere, setMarkHere] = useState(false)
  // And how long the video is, which is where a loop with no B pinned ends. The
  // player learns it a beat after it's handed a video, and it rides along on
  // this tick rather than bringing a timer of its own — both are questions only
  // the player can answer, and both are cheap to ask.
  const [duration, setDuration] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = playerRef.current
      const at = p?.getCurrentTime() ?? 0
      setMarkHere(Boolean(p) && bookmarksRef.current.some((b) => Math.abs(b.position_seconds - at) <= TOGGLE_TOLERANCE_SEC))
      setDuration(p?.getDuration() ?? 0)
    }, MARK_HERE_TICK_MS)
    return () => window.clearInterval(id)
  }, [playerRef])

  useEffect(() => {
    setBookmarks([])
    setLoops([])
    loopsRef.current = []
    // Cleared with the marks rather than left to the next poll: half a second of
    // a button offering to clear a bookmark the new video hasn't got is half a
    // second of it lying. The duration goes the same way — the old video's
    // length is the wrong end for a loop on the new one.
    setMarkHere(false)
    setDuration(0)
    let cancelled = false
    apiFetch(`/api/bookmarks/${videoId}`, { quiet: true })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setBookmarks(Array.isArray(d) ? d : []) })
      .catch(() => { /* no bookmarks shown; adding one still works */ })
    // The passages marked in this video, including which one was running. A loop
    // is work on a passage — the bar of music, the sentence in the other
    // language — and that work is about the video, so coming back to the video
    // comes back to it.
    apiFetch(`/api/bookmarks/${videoId}/loops`, { quiet: true })
      .then((r) => r.json())
      .then((d: unknown) => {
        // Never over passages marked since: the fetch is a round trip, and `[`
        // is pressed the moment the passage arrives.
        if (cancelled || !Array.isArray(d) || loopsRef.current.length) return
        loopsRef.current = d
        setLoops(d)
      })
      .catch(() => { /* the video plays through; pinning an end still works */ })
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

  // ── Writing the list ───────────────────────────────────────────────
  //
  // Three actions cover every change: open a passage, edit one, drop one. They
  // all land locally first — a loop that appears a beat after the keypress reads
  // as a dropped press — and they all write the ref as well as the state, now
  // rather than at the next render, because two presses can land inside one.
  //
  // A passage that hasn't reached the server yet carries a NEGATIVE id, the way
  // a fresh bookmark does. Nothing is sent under one; the POST that made it
  // reconciles whatever happened while it was in flight.

  const writeLoops = useCallback((next: SavedLoop[]) => {
    loopsRef.current = next
    setLoops(next)
    // Ahead of the poll below, for the same reason markHere is: `[` on its own
    // starts a loop running to the end of the video, and a button that waits
    // half a second to say so reads as a press that didn't take.
    const p = playerRef.current
    if (p) setDuration(p.getDuration())
  }, [playerRef])

  const sendLoop = useCallback((id: number, change: Partial<SavedLoop>) => {
    apiFetch(`/api/bookmarks/${videoId}/loops/id/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(change),
      quiet: true,
    }).catch(() => { /* the loop still runs this sitting */ })
  }, [videoId])

  /** Mark a new passage with one end pinned. It becomes the running one — you
   *  only mark a passage when it's the one you're about to work on. */
  const openLoop = useCallback((end: 'a' | 'b', at: number) => {
    const temp: SavedLoop = { id: -Date.now(), a: end === 'a' ? at : null, b: end === 'b' ? at : null, active: true }
    writeLoops([...loopsRef.current.map((l) => ({ ...l, active: false })), temp])
    apiFetch(`/api/bookmarks/${videoId}/loops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: temp.a, b: temp.b }),
      quiet: true,
    })
      .then((r) => r.json())
      .then((saved: SavedLoop) => {
        if (!saved?.id) return
        const now = loopsRef.current.find((l) => l.id === temp.id)
        if (!now) {
          // Dropped from the menu while the POST was in flight. It exists on the
          // server for a moment and then doesn't.
          apiFetch(`/api/bookmarks/${videoId}/loops/id/${saved.id}`, { method: 'DELETE', quiet: true })
            .catch(() => { /* nothing shows it either way */ })
          return
        }
        writeLoops(loopsRef.current.map((l) => (l.id === temp.id ? { ...l, id: saved.id } : l)))
        // Ends moved, or the passage switched away from, while it had no id to
        // send them under. They go out now.
        if (now.a !== temp.a || now.b !== temp.b || now.active !== temp.active) {
          sendLoop(saved.id, { a: now.a, b: now.b, active: now.active })
        }
      })
      .catch(() => writeLoops(loopsRef.current.filter((l) => l.id !== temp.id)))
  }, [videoId, writeLoops, sendLoop])

  /** Move an end, or switch to this passage. Switching clears the rest, because
   *  only one passage of a video repeats at a time. */
  const editLoop = useCallback((id: number, change: Partial<Pick<SavedLoop, 'a' | 'b' | 'active'>>) => {
    writeLoops(loopsRef.current.map((l) => (
      l.id === id ? { ...l, ...change } : change.active ? { ...l, active: false } : l
    )))
    if (id > 0) sendLoop(id, change)
  }, [writeLoops, sendLoop])

  /** Drop a passage for good — the menu's ×. */
  const dropLoop = useCallback((id: number) => {
    writeLoops(loopsRef.current.filter((l) => l.id !== id))
    if (id < 0) return  // never reached the server; the POST will clean it up
    apiFetch(`/api/bookmarks/${videoId}/loops/id/${id}`, { method: 'DELETE', quiet: true })
      .catch(() => { /* gone from view either way */ })
    showFlash('loop', 'Passage deleted')
  }, [videoId, writeLoops, showFlash])

  /** Stop repeating, keeping the passage. `\\` and the menu's own row.
   *
   *  Stopping is not deleting: the passage you marked is work, and the key that
   *  turns the repeat off shouldn't throw it away. The × in the menu does that. */
  const clearLoop = useCallback(() => {
    const running = loopsRef.current.find((l) => l.active)
    if (!running) return
    editLoop(running.id, { active: false })
    showFlash('loop', 'Repeat off')
  }, [editLoop, showFlash])

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
   *  moved afterwards, and one end on its own already repeats — from the start
   *  of the video, or to the end of it (see loopBounds). */
  const setLoopEnd = useCallback((end: 'a' | 'b', at: number) => {
    const running = loopsRef.current.find((l) => l.active)
    // With nothing running, pinning an end opens a passage rather than editing
    // one — so `[` on a video you've never looped behaves as it always did.
    if (running) editLoop(running.id, { [end]: at })
    else openLoop(end, at)
    showFlash('loop', `Loop ${end.toUpperCase()} · ${formatTime(at)}`)
  }, [editLoop, openLoop, showFlash])

  // Send the play head back to A each time it reaches B. Runs on its own timer
  // rather than the caption tick, which only exists while captions are on.
  useEffect(() => {
    if (loop.a === null && loop.b === null) return
    const id = window.setInterval(() => {
      const p = playerRef.current
      if (!p) return
      // Resolved here, against the length the player reports NOW: an unpinned B
      // is the end of the video, and the player often doesn't know where that is
      // until a moment after the loop was pinned.
      const ends = loopBounds(loop, p.getDuration())
      if (!ends) return
      // A loop running to the end of the video is reached by the video ENDING as
      // much as by passing a timestamp — the player can stop a hair short of the
      // duration it reported, and then nothing ever passes B.
      const ended = p.getPlayerState() === 0
      if (p.getCurrentTime() < ends.b && !ended) return
      p.seekTo(ends.a, true)
      // Seeking a finished player leaves it paused at A. Nudge it back to play.
      if (p.getPlayerState() !== 1) p.playVideo()
    }, LOOP_TICK_MS)
    return () => window.clearInterval(id)
  }, [loop, playerRef])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
        || (t instanceof HTMLElement && t.isContentEditable)) return
      // A shortcut is a BARE key. Chords belong to the browser and the OS:
      // ⌘C/⌘F/⌘L, and on a Mac ⌘[ / ⌘] are back and forward — all of which we
      // would otherwise swallow, since we match on `key` alone. Copying text out
      // of the page was the one people hit.
      if (e.metaKey || e.ctrlKey || e.altKey) return
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

  // Two questions, and the loop button asks both.
  //
  // `looping` is whether the video is actually repeating. One end pinned is
  // enough for that, so it isn't the same as how far along the pinning is.
  //
  // `loopStage` is how far along the pinning is, which is what the button's
  // badge names and what the menu's own rows read from.
  const looping = loopActive(loop, duration)
  const loopStage: LoopStage = loop.a !== null && loop.b !== null && looping
    ? 'running'
    : (loop.a !== null || loop.b !== null) ? 'arming' : 'idle'

  /** Pin an end of the running passage at the play head — the menu's own `[`
   *  and `]`, with the position read for you. */
  const pinLoopEnd = useCallback((end: 'a' | 'b') => {
    const p = playerRef.current
    if (p) setLoopEnd(end, p.getCurrentTime())
  }, [playerRef, setLoopEnd])

  /** Mark a new passage starting here, and work on it.
   *
   *  One press rather than "make an empty one, then pin its start", because
   *  there is no reason to mark a passage except to start on it, and where you
   *  are is where it starts. */
  const newLoop = useCallback(() => {
    const p = playerRef.current
    if (!p) return
    openLoop('a', p.getCurrentTime())
    showFlash('loop', `New passage · from ${formatTime(p.getCurrentTime())}`)
  }, [playerRef, openLoop, showFlash])

  /** Switch to a saved passage: it starts repeating, and the play head goes to
   *  the top of it. Seeking is the point — you picked it to hear it, and a
   *  switch that left you outside the passage would make you wait for the loop
   *  to come round before anything happened. */
  const useLoop = useCallback((id: number) => {
    const target = loopsRef.current.find((l) => l.id === id)
    if (!target) return
    editLoop(id, { active: true })
    const p = playerRef.current
    if (p) p.seekTo(target.a ?? 0, true)
    showFlash('loop', `Repeating · ${loopLabel(target)}`)
  }, [editLoop, playerRef, showFlash])

  /** Bookmark (or clear) wherever the play head is, for the bar's button — the
   *  keyboard's `b` with the position read for you. Clicking a mark on the track
   *  seeks exactly to it, so that plus this button is how one gets cleared
   *  without hunting for the moment by hand. */
  const toggleBookmarkHere = useCallback(() => {
    const p = playerRef.current
    if (p) toggleBookmarkAt(p.getCurrentTime())
  }, [playerRef, toggleBookmarkAt])

  return {
    bookmarks, loop, loops, others, loopStage, looping, markHere, flash,
    toggleBookmarkHere, pinLoopEnd, newLoop, useLoop, dropLoop, clearLoop,
  }
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
export function MarkTrack({ bookmarks, loop, others = [], duration, onSeek }: {
  bookmarks: Bookmark[]
  loop: Loop
  /** The video's other saved passages — everything except the running one.
   *  Drawn as cuts and nothing else: they aren't clickable, because switching
   *  passages is the menu's job and every hit area here is a pixel of YouTube's
   *  own scrubber taken. */
  others?: Loop[]
  duration: number
  onSeek: (seconds: number) => void
}) {
  if (!duration) return null
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`
  const showLoop = loop.a !== null || loop.b !== null
  // Where the repeat actually runs from and to — which, with one end pinned, is
  // wider than what was pinned: the dim runs to the start or the end of the bar
  // and one of the two veils comes out zero-width.
  const bounds = loopBounds(loop, duration)
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
          video would claim something repeats when nothing does. With one end
          pinned it IS running, so half the bar dims and the other veil is empty.

          It veils the fill along with the track, which is the point — the played
          portion outside the loop is exactly the part you're no longer watching.
          The thumb is drawn after this, so the play head stays bright wherever
          it is, and so do any bookmarks: those aren't the loop's business. */}
      {bounds && (
        <>
          <div
            data-testid="loop-dim"
            className={`pointer-events-none absolute inset-y-0 left-0 rounded-l-full ${LOOP_DIM}`}
            style={{ width: pct(bounds.a) }}
          />
          <div
            data-testid="loop-dim"
            className={`pointer-events-none absolute inset-y-0 right-0 rounded-r-full ${LOOP_DIM}`}
            style={{ left: pct(bounds.b) }}
          />
        </>
      )}
      {/* The other passages, as cuts alone. Drawn first, so the running one's
          darker cuts sit over them where two passages share a boundary. */}
      {others.flatMap((other, i) => [other.a, other.b].map((end, j) => end === null ? null : (
        <div
          key={`other${i}-${j}`}
          data-testid="loop-edge-idle"
          className={`pointer-events-none absolute inset-y-0 w-[2px] -translate-x-1/2 ${LOOP_EDGE_IDLE}`}
          style={{ left: pct(end) }}
        />
      )))}
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

/** The video's saved passages, and everything you can do to one.
 *
 *  A menu rather than a cycling button, because with several passages the
 *  question the button answers stopped being "what's the next step" and became
 *  "which one" — and that has as many answers as you have passages. The keyboard
 *  keeps the fast path: `[` and `]` pin the ends of whichever passage is
 *  running, `\\` stops it.
 *
 *  Every row here is one of those keys with the position read for you, so the
 *  menu can't do anything the shortcuts can't, and the shortcuts can't do the
 *  two things only a list can: switch, and delete.
 *
 *  It's laid over the video, so it closes on Escape and on any click outside —
 *  the same as the player's own menus. The caller places it.
 */
export function LoopMenu({ loops, duration, stage, onPin, onUse, onDrop, onStop, onNew, onClose }: {
  loops: SavedLoop[]
  duration: number
  stage: LoopStage
  onPin: (end: 'a' | 'b') => void
  onUse: (id: number) => void
  onDrop: (id: number) => void
  onStop: () => void
  onNew: () => void
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // Capture, because the page's own handlers sit on window too and a click
    // meant to dismiss shouldn't also reach whatever is under it.
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose])

  // Choosing a passage to work on closes the menu; managing the list doesn't.
  // Once you've picked one you want to hear it, and the panel sits over the
  // video — but pinning an end, deleting, and stopping are all things you may do
  // twice in a row, and reopening between them would be the annoying half.
  const chose = (act: () => void) => () => { act(); onClose() }
  const row = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-white transition-colors hover:bg-white/10'
  return (
    <div
      ref={box}
      data-testid="loop-menu"
      role="menu"
      className="absolute bottom-full right-0 z-40 mb-2 min-w-[15rem] overflow-hidden rounded-xl bg-[#282828] py-1.5 shadow-2xl ring-1 ring-white/10"
    >
      <div className="px-3 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-white/45">
        Repeat
      </div>
      {/* The passages. Bounded here rather than on the panel, so the actions
          below stay put however many you've marked. */}
      <div className="max-h-56 overflow-y-auto">
        {loops.map((l) => (
          <div key={l.id} className={`group/row flex items-center ${l.active ? 'bg-white/10' : ''}`}>
            <button
              role="menuitem"
              onClick={l.active ? onStop : chose(() => onUse(l.id))}
              title={l.active ? 'Stop repeating (\\)' : 'Repeat this passage'}
              className={row}
            >
              {/* Whether this is the one running. In white, like everything the
                  loop wears: it takes no colour of its own here either. */}
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${l.active ? 'bg-white' : 'bg-white/25'}`} />
              <span className="tabular-nums">{loopLabel(l)}</span>
              {!loopActive(l, duration) && (
                // Marked but not repeating — an end pinned the wrong side of the
                // other, or a passage too short to be one. Said plainly, since
                // the bar can't show a loop that isn't running.
                <span className="ml-auto pl-2 text-xs text-white/40">not looping</span>
              )}
            </button>
            <button
              onClick={() => onDrop(l.id)}
              title="Delete this passage"
              aria-label={`Delete passage ${loopLabel(l)}`}
              className="mr-1 shrink-0 rounded p-1 text-white/40 opacity-0 transition-opacity hover:bg-white/10 hover:text-white focus:opacity-100 group-hover/row:opacity-100"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        ))}
        {!loops.length && (
          <div className="px-3 py-2 text-sm text-white/45">Nothing marked yet.</div>
        )}
      </div>
      <div className="mt-1 border-t border-white/10 pt-1">
        {/* The two keys, as buttons. They act on the running passage, or open
            one — so they're never a press that does nothing. */}
        <div className="flex gap-1 px-1.5 py-0.5">
          {(['a', 'b'] as const).map((end) => (
            <button
              key={end}
              role="menuitem"
              onClick={() => onPin(end)}
              title={`Pin the ${end === 'a' ? 'start ([' : 'end (]'}) at the play head`}
              className="flex-1 rounded-lg px-2 py-1.5 text-sm text-white transition-colors hover:bg-white/10"
            >
              Pin {end === 'a' ? 'start' : 'end'}
              <span className="ml-1.5 text-white/40">{end === 'a' ? '[' : ']'}</span>
            </button>
          ))}
        </div>
        <button role="menuitem" onClick={chose(onNew)} className={row}>
          <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" d="M12 5v14M5 12h14" />
          </svg>
          New passage from here
        </button>
        {stage !== 'idle' && (
          <button role="menuitem" onClick={onStop} className={row}>
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            Stop repeating
            <span className="ml-auto pl-2 text-white/40">\</span>
          </button>
        )}
      </div>
    </div>
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
export function EmbedMarkRail({ bookmarks, loop, others = [], duration, onSeek }: {
  bookmarks: Bookmark[]
  loop: Loop
  others?: Loop[]
  duration: number
  onSeek: (seconds: number) => void
}) {
  if (!duration || (!bookmarks.length && !others.length && loop.a === null && loop.b === null)) return null
  return (
    <div
      className="pointer-events-none absolute z-20"
      style={{ bottom: EMBED_BAR_BOTTOM, left: EMBED_BAR_INSET, right: EMBED_BAR_INSET }}
    >
      <div className="pointer-events-none relative h-1">
        <MarkTrack bookmarks={bookmarks} loop={loop} others={others} duration={duration} onSeek={onSeek} />
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
