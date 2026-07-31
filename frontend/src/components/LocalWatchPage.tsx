import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../lib/api'
import { formatTime } from '../lib/time'
import { formatSize, watchedRatio } from '../lib/local'
import { useVolume, setAudioVolume } from '../hooks/audioStore'
import LocalControls from './LocalControls'
import type { LocalFolder, LocalVideo } from '../lib/local'

type Props = {
  video: LocalVideo
  folder: LocalFolder | null
  // The rest of the folder, for the up-next list beside the player.
  siblings: LocalVideo[]
  onClose: () => void
  onSelect: (video: LocalVideo) => void
  // Called after a position is written, so the folder grid's resume bars update.
  onProgress?: () => void
}

// How often a playing video reports where it got to.
const REPORT_SEC = 5
// Below this, a position is a click, not a watch (the backend agrees).
const RESUME_MIN_SEC = 5
// Stopped this close to the end? Start from the top instead of the credits.
const RESUME_TAIL_SEC = 15

/** The player for a file in a local folder.
 *
 * A slimmer sibling of WatchPage: a local file has no description, transcript,
 * stats or channel, so what's left is the player, the file's own details, and
 * the rest of the folder to pick from. The player itself is the SAME one a
 * downloaded video uses — LocalControls — so the scrub preview, the shared
 * volume and the shortcuts all behave identically.
 */
export default function LocalWatchPage({ video, folder, siblings, onClose, onSelect, onProgress }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [hovering, setHovering] = useState(false)
  const volume = useVolume()
  const volumeRef = useRef(volume)
  volumeRef.current = volume
  const resumedRef = useRef(false)

  // Where we left off. Resolved from the row we were handed — the folder listing
  // already carries it, so there's nothing extra to fetch.
  const resumeAt = (() => {
    const pos = video.position_seconds || 0
    const dur = video.duration_seconds || 0
    if (video.watched || pos <= RESUME_MIN_SEC) return 0
    if (dur > 0 && dur - pos <= RESUME_TAIL_SEC) return 0
    return pos
  })()

  // Everything that has to wait for the file's metadata: the resume seek (which
  // needs a seekable element) and the shared volume (the element starts at 1.0).
  const onLoadedMetadata = () => {
    const el = videoRef.current
    if (!el) return
    el.volume = Math.max(0, Math.min(1, volumeRef.current / 100))
    if (!resumedRef.current && resumeAt > 0) el.currentTime = resumeAt
    resumedRef.current = true
    boxRef.current?.focus()
    el.play().catch(() => {
      // Autoplay with sound can be refused; muted always plays, and the bar
      // makes it obvious how to get the sound back.
      el.muted = true
      el.play().catch(() => { /* leave it paused — the controls still work */ })
    })
  }

  // Follow the shared volume while playing (the slider writes to the store).
  useEffect(() => {
    const el = videoRef.current
    if (el && !el.muted) el.volume = Math.max(0, Math.min(1, volume / 100))
  }, [volume])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else boxRef.current?.requestFullscreen?.()
  }

  // Report progress on a timer while it plays, and once more on the way out
  // (closing, switching video, navigating away) — the same contract the YouTube
  // side has with watch history.
  useEffect(() => {
    const report = (keepalive = false) => {
      const el = videoRef.current
      if (!el || !el.currentTime) return
      apiFetch(`/api/local/videos/${video.id}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive,
        quiet: true,
        body: JSON.stringify({
          position_seconds: el.currentTime,
          duration_seconds: Math.round(Number.isFinite(el.duration) ? el.duration : 0),
        }),
      }).then(() => onProgress?.()).catch(() => { /* best-effort */ })
    }
    const id = window.setInterval(() => {
      const el = videoRef.current
      if (el && !el.paused) report()
    }, REPORT_SEC * 1000)
    const onHide = () => { if (document.visibilityState === 'hidden') report(true) }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onHide)
      report(true)
    }
    // onProgress is a stable callback from App; re-running this per video is the
    // point (each mount reports for the video it was mounted with).
  }, [video.id])  // eslint-disable-line react-hooks/exhaustive-deps

  // Page-level shortcuts, matching the watch page's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = videoRef.current
      if (!el) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const seek = (delta: number) => { el.currentTime = Math.max(0, el.currentTime + delta) }
      switch (e.key) {
        case ' ': case 'k': case 'K':
          e.preventDefault()
          if (el.paused) void el.play().catch(() => {}); else el.pause()
          break
        case 'm': case 'M': el.muted = !el.muted; break
        case 'f': case 'F': toggleFullscreen(); break
        case 'ArrowLeft': e.preventDefault(); seek(-5); break
        case 'ArrowRight': e.preventDefault(); seek(5); break
        case 'j': case 'J': seek(-10); break
        case 'l': case 'L': seek(10); break
        case 'ArrowUp': e.preventDefault(); setAudioVolume(Math.min(100, volumeRef.current + 5)); break
        case 'ArrowDown': e.preventDefault(); setAudioVolume(Math.max(0, volumeRef.current - 5)); break
        case 'Escape': if (!document.fullscreenElement) onClose(); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const upNext = siblings.filter((s) => s.id !== video.id)

  return (
    <div className="flex h-full flex-col">
      <div
        ref={boxRef}
        tabIndex={-1}
        className="relative w-full shrink-0 bg-black outline-none aspect-video [&:fullscreen]:aspect-auto"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <video
          key={video.id}
          ref={videoRef}
          src={video.file_url}
          onLoadedMetadata={onLoadedMetadata}
          onClick={() => {
            const el = videoRef.current
            if (!el) return
            if (el.paused) void el.play().catch(() => {}); else el.pause()
          }}
          autoPlay
          playsInline
          className="absolute inset-0 h-full w-full bg-black"
        />
        <LocalControls
          videoRef={videoRef}
          src={video.file_url}
          hovering={hovering}
          onFullscreen={toggleFullscreen}
        />
        <button
          onClick={onClose}
          className="absolute left-2 top-2 z-30 rounded-full bg-black/60 p-2 text-white transition-colors hover:bg-black/80"
          title="Back to the folder (Esc)"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 px-4 py-4 md:px-6 lg:flex-row">
          <div className="min-w-0 flex-1 lg:max-w-[1100px]">
            <h1 className="text-xl font-semibold text-white">{video.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[#aaa]">
              {folder && <span className="text-white">{folder.name}</span>}
              {video.sub_dir && <span>· {video.sub_dir}</span>}
              <span>· {formatSize(video.filesize)}</span>
              {video.duration_seconds > 0 && <span>· {formatTime(video.duration_seconds)}</span>}
              {video.modified_at && <span>· {video.modified_at.slice(0, 10)}</span>}
            </div>
            <p className="mt-3 break-all rounded-lg bg-[#121212] px-3 py-2 font-mono text-xs text-[#717171]">
              {folder ? `${folder.path}/${video.rel_path}` : video.rel_path}
            </p>
          </div>

          {upNext.length > 0 && (
            <div className="w-full lg:w-[400px] lg:flex-shrink-0">
              <h2 className="mb-2 text-sm font-medium text-white">More in this folder</h2>
              <div className="flex flex-col gap-2">
                {upNext.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onSelect(s)}
                    className="flex gap-2 rounded-lg p-1 text-left transition-colors hover:bg-[#1c1c1c]"
                  >
                    <div className="relative aspect-video w-[168px] flex-shrink-0 overflow-hidden rounded bg-[#1c1c1c]">
                      <img src={s.thumbnail_url} alt="" loading="lazy" className="h-full w-full object-cover" />
                      {s.duration_seconds > 0 && (
                        <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[11px] text-white">
                          {formatTime(s.duration_seconds)}
                        </span>
                      )}
                      {watchedRatio(s) > 0 && (
                        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/25">
                          <div className="h-full bg-red-600" style={{ width: `${watchedRatio(s) * 100}%` }} />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-sm text-white">{s.title}</div>
                      <div className="mt-0.5 text-xs text-[#717171]">{formatSize(s.filesize)}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
