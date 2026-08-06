/**
 * The local player: a plain <video> dressed as the YouTube player.
 *
 * Two things live here, shared by everything that plays a file from disk — a
 * finished download on the watch page, and a file from a local folder:
 *
 *  - localPlayer(), which adapts an <video> to the slice of the IFrame API the
 *    watch page drives, so captions/history/shortcuts don't care about the source
 *  - LocalControls, our own control bar
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useVolume, setAudioVolume } from '../hooks/audioStore'
import { formatTime } from '../lib/time'
import { storyboardFrame, scaleToWidth } from '../lib/storyboard'
import type { StoryboardInfo } from '../lib/storyboard'
import { MarkTrack } from './PlayerMarks'
import type { Bookmark, Loop } from './PlayerMarks'

// The scrub popup's size. Both sources render into it: the local <video>, and a
// storyboard frame scaled to match (see `sbFrame` below).
//
// 240 rather than something larger because the storyboard has to stay sharp:
// the sheets are served at a fixed tile size — 320x180 on the ones YouTube
// hands us for a typical video — and scaling past that only magnifies JPEG.
// A file on disk has no such ceiling, but one number keeps the two previews the
// same popup, which is the point.
const PREVIEW_W = 240
const PREVIEW_H = Math.round((PREVIEW_W * 9) / 16)

// The slice of the YouTube IFrame API the rest of this component drives the
// player through. A downloaded file is played by a plain <video>, so it gets an
// adapter with the same shape (below) and every caller — history, captions,
// keyboard shortcuts, the shared volume — works unchanged either way.
export type PlayerApi = {
  setVolume: (v: number) => void
  getVolume: () => number
  isMuted: () => boolean
  mute: () => void
  unMute: () => void
  playVideo: () => void
  pauseVideo: () => void
  getPlayerState: () => number
  getCurrentTime: () => number
  getDuration: () => number
  seekTo: (seconds: number, allowSeekAhead: boolean) => void
}

/** Wrap a <video> element in the PlayerApi, matching YouTube's conventions:
 *  volume is 0–100 (not 0–1), and the state codes are 0 = ended, 1 = playing,
 *  2 = paused — the only three values any caller here compares against. */
export function localPlayer(el: HTMLVideoElement): PlayerApi {
  return {
    setVolume: (v) => { el.volume = Math.max(0, Math.min(1, v / 100)) },
    getVolume: () => el.volume * 100,
    isMuted: () => el.muted,
    mute: () => { el.muted = true },
    unMute: () => { el.muted = false },
    playVideo: () => { void el.play().catch(() => { /* autoplay policy */ }) },
    pauseVideo: () => el.pause(),
    getPlayerState: () => (el.ended ? 0 : el.paused ? 2 : 1),
    getCurrentTime: () => el.currentTime,
    getDuration: () => (Number.isFinite(el.duration) ? el.duration : 0),
    seekTo: (seconds) => { el.currentTime = seconds },
  }
}

/** Our control bar, in place of the player's own.
 *
 *  For a file on disk it replaces the browser's native bar, which can't show a
 *  scrub preview: hovering the progress bar seeks a second, hidden <video> of the
 *  same file to that moment and shows the frame, exactly like the card's preview
 *  scrubber — the file is already there, so the frame is instant and needs no
 *  storyboard fetch.
 *
 *  It also drives the YouTube embed, where `player` stands in for `videoRef`.
 *  The difference is only in how state arrives: a <video> tells us when it
 *  changes, the embed has to be asked. There is no scrub preview there — the
 *  frames aren't ours to seek.
 *
 *  That second mode only runs with the companion extension installed, which is
 *  what strips YouTube's own overlays from inside the iframe. Without it the
 *  watch page keeps YouTube's controls and never renders this bar over an embed
 *  (see EMBED_OWN_CONTROLS in WatchPage), so the bar can look the same in both
 *  modes — there is no leftover chrome for it to paint over. */
export default function LocalControls({ videoRef, player, src, storyboard, hovering, onFullscreen, leftControls, extraControls, bookmarks, loop }: {
  // One of these two. `videoRef` + `src` give the scrub preview its frames
  // directly; over the embed, `storyboard` supplies them instead.
  videoRef?: RefObject<HTMLVideoElement | null>
  player?: RefObject<PlayerApi | null>
  src?: string
  // YouTube's scrub sprite sheets, for the embed. Null until they arrive (or if
  // the video has none) — the preview falls back to the timestamp alone.
  storyboard?: StoryboardInfo | null
  hovering: boolean
  onFullscreen: () => void
  // Controls the page owns, placed in the row instead of floating over the
  // video: captions on the left (after the clock, as YouTube has it), the rest
  // in the right-hand group.
  leftControls?: ReactNode
  extraControls?: ReactNode
  // Drawn on the track: bookmarks as ticks, the A–B loop as a span (MarkTrack).
  // They need no click handling here — the bar already seeks to wherever you
  // click it, which for a tick is the moment it marks.
  bookmarks?: Bookmark[]
  loop?: Loop
}) {
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [paused, setPaused] = useState(true)
  const [muted, setMuted] = useState(false)
  const [hoverRatio, setHoverRatio] = useState<number | null>(null)
  // The slider reads and writes the SHARED volume (the same store the previews
  // and the embed use), so a level set here follows you to the next video.
  const volume = useVolume()
  const barRef = useRef<HTMLDivElement>(null)
  const scrubRef = useRef<HTMLVideoElement>(null)
  const draggingRef = useRef(false)

  // Whichever source we were handed, through one shape. Rebuilt per call — the
  // adapter is three lines of closures over the element, not a resource.
  const api = (): PlayerApi | null => {
    const el = videoRef?.current
    return el ? localPlayer(el) : player?.current ?? null
  }

  // Mirror the source's state. A <video> tells us when it changes, which covers
  // every way the position can move (the keyboard shortcuts, the resume seek);
  // the embed says nothing, so it gets asked four times a second — the same rate
  // `timeupdate` fires at anyway.
  useEffect(() => {
    const sync = () => {
      const p = api()
      if (!p) return
      setTime(p.getCurrentTime())
      // Buffering counts as running, so a stall neither flips the button to
      // "play" nor pins the bar open. (localPlayer never reports it.)
      const s = p.getPlayerState()
      setPaused(s !== 1 && s !== 3)
      setMuted(p.isMuted())
      setDuration(p.getDuration())
    }
    sync()
    const el = videoRef?.current
    const events = ['timeupdate', 'play', 'pause', 'seeked', 'durationchange', 'volumechange', 'loadedmetadata']
    if (el) events.forEach((e) => el.addEventListener(e, sync))
    const id = el ? undefined : window.setInterval(sync, 250)
    return () => {
      if (el) events.forEach((e) => el.removeEventListener(e, sync))
      if (id) window.clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, player])

  const hoverTime = hoverRatio !== null && duration ? hoverRatio * duration : null
  useEffect(() => {
    if (scrubRef.current && hoverTime !== null) scrubRef.current.currentTime = hoverTime
  }, [hoverTime])
  // The popup fades out rather than vanishing, so it still renders for a beat
  // after the cursor leaves. Hold the last hovered spot for that beat: reading
  // the live (now null) values would snap it to the middle showing 0:00 on the
  // way out. The scrub video keeps following hoverTime, so it doesn't re-seek.
  const lastHover = useRef({ ratio: 0.5, time: 0 })
  if (hoverRatio !== null && hoverTime !== null) lastHover.current = { ratio: hoverRatio, time: hoverTime }
  const shownRatio = hoverRatio ?? lastHover.current.ratio
  const shownTime = hoverTime ?? lastHover.current.time

  const ratioAt = (clientX: number) => {
    const bar = barRef.current
    if (!bar) return null
    const r = bar.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }
  const seekTo = (clientX: number) => {
    const p = api()
    const ratio = ratioAt(clientX)
    if (!p || ratio === null || !duration) return
    p.seekTo(ratio * duration, true)
    setTime(ratio * duration)
  }

  // Shown while the pointer is over the player, and whenever it's paused — a
  // paused video with no controls looks broken.
  const show = hovering || paused
  const progress = duration ? time / duration : 0

  // The frame under the cursor, cut from YouTube's sprite sheet. Follows
  // `shownTime` rather than `hoverTime` so it holds its picture while the popup
  // fades out, the same way the timestamp does.
  const sbFrame = storyboard && !src
    ? storyboardFrame(storyboard, shownTime, scaleToWidth(storyboard, PREVIEW_W))
    : null
  const hasFrame = Boolean(src) || Boolean(sbFrame)

  return (
    <div
      className={`absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-8 transition-opacity duration-150 ${
        show ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    >
      {/* Scrub preview — a fixed-width popup so it keeps its size when clamped
          against either edge. Sits clear of the bar: the container's bottom
          padding, the button row and the bar's own hit area come to ~4.5rem, so
          anything shorter puts the timestamp on top of the track. With no frame
          to show it narrows to just the timestamp, and sits lower to match. */}
      <div
        className="pointer-events-none absolute transition-opacity duration-75"
        style={{
          bottom: hasFrame ? '4.75rem' : '3.25rem',
          width: PREVIEW_W,
          // Clamped by HALF the popup, since it's centred on the cursor — that's
          // exactly how far it can travel before an edge clips it.
          left: `clamp(${PREVIEW_W / 2}px, ${(shownRatio * 100).toFixed(2)}%, calc(100% - ${PREVIEW_W / 2}px))`,
          transform: 'translateX(-50%)',
          opacity: hoverRatio !== null ? 1 : 0,
        }}
      >
        {src ? (
          <video
            ref={scrubRef}
            src={src}
            muted
            preload="auto"
            className="rounded border border-white/20 bg-black object-cover shadow-lg"
            style={{ width: PREVIEW_W, height: PREVIEW_H, maxWidth: 'none' }}
          />
        ) : sbFrame && (
          /* The same popup over the embed, its frame cut out of one of YouTube's
             sprite sheets. Scaled to the popup's width so it lines up with the
             <video> above — sheets differ in frame size between videos, so a
             fixed scale would not. */
          <div
            data-testid="scrub-storyboard"
            className="rounded border border-white/20 bg-black shadow-lg"
            style={{
              width: sbFrame.fw,
              height: sbFrame.fh,
              backgroundImage: `url(${sbFrame.url})`,
              backgroundPosition: `${sbFrame.bgX}px ${sbFrame.bgY}px`,
              backgroundRepeat: 'no-repeat',
              backgroundSize: `${sbFrame.sheetW}px ${sbFrame.sheetH}px`,
            }}
          />
        )}
        <div className="mt-1 text-center">
          <span className="inline-block rounded bg-black/80 px-1.5 py-0.5 text-sm font-semibold text-white">
            {formatTime(shownTime)}
          </span>
        </div>
      </div>

      {/* Progress bar. The padded wrapper is the hit area (and the measured rect —
          its horizontal edges match the track's). */}
      <div
        ref={barRef}
        className="group/bar cursor-pointer py-2"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          draggingRef.current = true
          seekTo(e.clientX)
        }}
        onPointerMove={(e) => {
          setHoverRatio(ratioAt(e.clientX))
          if (draggingRef.current) seekTo(e.clientX)
        }}
        // Drop the preview as soon as the cursor leaves the BAR — leaving it to
        // the whole controls area kept the thumbnail up while you were off using
        // the buttons. A drag holds the pointer capture, which suppresses this,
        // so scrubbing past the ends is unaffected.
        onPointerLeave={() => setHoverRatio(null)}
        onPointerUp={() => { draggingRef.current = false }}
      >
        {/* Thickens on hover, YouTube-style, to make the target read as grabbable. */}
        <div className="relative h-1 rounded-full bg-white/30 transition-all group-hover/bar:h-[5px]">
          <div className="absolute inset-y-0 left-0 rounded-full bg-red-500" style={{ width: `${progress * 100}%` }} />
          {/* Bookmarks and the A–B loop, on the track they're positions on.
              Clicking a mark seeks to the exact moment it marks rather than to
              wherever on the track the click landed. */}
          <MarkTrack
            bookmarks={bookmarks ?? []}
            loop={loop ?? { a: null, b: null }}
            duration={duration}
            onSeek={(seconds) => {
              const p = api()
              if (!p) return
              p.seekTo(seconds, true)
              setTime(seconds)
            }}
          />
          {hoverRatio !== null && (
            <div
              className="pointer-events-none absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-white/50"
              style={{ left: `${hoverRatio * 100}%` }}
            />
          )}
          <div
            className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500 shadow"
            style={{ left: `${progress * 100}%` }}
          />
        </div>
      </div>

      {/* Play / mute / clock on the left, fullscreen on the right. Everything
          here also has a keyboard shortcut (k, m, f) — see the key handler. */}
      <div className="flex items-center gap-3 text-white">
        <button
          onClick={() => { const p = api(); if (!p) return; if (paused) p.playVideo(); else p.pauseVideo() }}
          className="rounded p-1 hover:bg-white/10"
          title={paused ? 'Play (k)' : 'Pause (k)'}
        >
          <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            {paused ? <path d="M8 5v14l11-7z" /> : <path d="M6 5h4v14H6zm8 0h4v14h-4z" />}
          </svg>
        </button>
        {/* Mute + volume, as one YouTube-style group: the slider is collapsed
            until the group is hovered (or the slider itself has focus, so it
            stays open while dragging or tabbing). */}
        <div className="group/vol flex items-center">
          <button
            onClick={() => { const p = api(); if (!p) return; if (p.isMuted()) p.unMute(); else p.mute() }}
            className="rounded p-1 hover:bg-white/10"
            title={muted ? 'Unmute (m)' : 'Mute (m)'}
          >
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              {muted || volume === 0
                ? <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3 2.7-2.7a1 1 0 0 0-1.4-1.4L15.1 10.6l-2.7-2.7v8.2l2.7-2.7 2.7 2.7a1 1 0 0 0 1.4-1.4L16.5 12z" />
                : <path d="M3 9v6h4l5 5V4L7 9H3zm11.5 3a4 4 0 0 0-2.2-3.6v7.2A4 4 0 0 0 14.5 12z" />}
            </svg>
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : volume}
            onChange={(e) => {
              const next = Number(e.target.value)
              // Dragging off zero unmutes, like YouTube — otherwise the slider
              // would move with no sound and look broken.
              if (next > 0) api()?.unMute()
              setAudioVolume(next)
            }}
            title="Volume (↑/↓)"
            aria-label="Volume"
            className="ml-1 h-1 w-0 cursor-pointer accent-white opacity-0 transition-all duration-150 group-hover/vol:w-16 group-hover/vol:opacity-100 focus:w-16 focus:opacity-100"
          />
        </div>
        <span className="text-xs tabular-nums text-white/90">
          {formatTime(time)} / {formatTime(duration)}
        </span>
        {leftControls}
        <div className="ml-auto flex items-center gap-1">
          {extraControls}
          <button
            onClick={onFullscreen}
            className="rounded p-1 hover:bg-white/10"
            title="Fullscreen (f)"
          >
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
