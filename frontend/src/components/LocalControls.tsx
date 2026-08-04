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
import { MarkTrack } from './PlayerMarks'
import type { Bookmark, Loop } from './PlayerMarks'

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

/** Controls for local playback, in place of the browser's native bar — which
 *  can't show a scrub preview. Hovering the progress bar seeks a second, hidden
 *  <video> of the same file to that moment and shows the frame, exactly like the
 *  card's preview scrubber: the file is already on disk, so the frame is instant
 *  and needs no storyboard fetch. The embed keeps YouTube's own bar. */
export default function LocalControls({ videoRef, src, hovering, onFullscreen, leftControls, extraControls, bookmarks, loop }: {
  videoRef: RefObject<HTMLVideoElement | null>
  src: string
  hovering: boolean
  onFullscreen: () => void
  // Controls the page owns, placed in the row instead of floating over the
  // video: captions on the left (after the clock, as YouTube has it), the rest
  // in the right-hand group.
  leftControls?: ReactNode
  extraControls?: ReactNode
  // Drawn on the track: bookmarks as ticks, the A–B loop as a span (MarkTrack).
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

  // Mirror the element's state rather than polling: these events cover every way
  // the position can change, including the keyboard shortcuts and the resume seek.
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const sync = () => {
      setTime(el.currentTime)
      setPaused(el.paused)
      setMuted(el.muted)
      setDuration(Number.isFinite(el.duration) ? el.duration : 0)
    }
    sync()
    const events = ['timeupdate', 'play', 'pause', 'seeked', 'durationchange', 'volumechange', 'loadedmetadata']
    events.forEach((e) => el.addEventListener(e, sync))
    return () => events.forEach((e) => el.removeEventListener(e, sync))
  }, [videoRef])

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
    const el = videoRef.current
    const ratio = ratioAt(clientX)
    if (!el || ratio === null || !duration) return
    el.currentTime = ratio * duration
    setTime(ratio * duration)
  }

  // Shown while the pointer is over the player, and whenever it's paused — a
  // paused video with no controls looks broken.
  const show = hovering || paused
  const progress = duration ? time / duration : 0

  return (
    <div
      className={`absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-8 transition-opacity duration-150 ${show ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
    >
      {/* Scrub preview — a fixed-width popup so it keeps its size when clamped
          against either edge. Sits clear of the bar: the container's bottom
          padding, the button row and the bar's own hit area come to ~4.5rem, so
          anything shorter puts the timestamp on top of the track. */}
      <div
        className="pointer-events-none absolute transition-opacity duration-75"
        style={{
          bottom: '4.75rem',
          width: 176,
          left: `clamp(88px, ${(shownRatio * 100).toFixed(2)}%, calc(100% - 88px))`,
          transform: 'translateX(-50%)',
          opacity: hoverRatio !== null ? 1 : 0,
        }}
      >
        <video
          ref={scrubRef}
          src={src}
          muted
          preload="auto"
          className="rounded border border-white/20 bg-black object-cover shadow-lg"
          style={{ width: 176, height: 99, maxWidth: 'none' }}
        />
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
              const el = videoRef.current
              if (!el) return
              el.currentTime = seconds
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
          onClick={() => { const el = videoRef.current; if (!el) return; if (el.paused) void el.play().catch(() => {}); else el.pause() }}
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
            onClick={() => { const el = videoRef.current; if (el) el.muted = !el.muted }}
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
              const el = videoRef.current
              // Dragging off zero unmutes, like YouTube — otherwise the slider
              // would move with no sound and look broken.
              if (el && next > 0) el.muted = false
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
