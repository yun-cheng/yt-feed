/**
 * Stills from a video file, at given moments — a bookmark's picture.
 *
 * The scrub popup seeks a hidden <video> live as you hover; a list of bookmarks
 * wants every frame at once and then for good, so here one detached <video>
 * walks the moments in turn, and each frame is drawn to a canvas and kept as a
 * small JPEG. The file is same-origin (the backend's FileResponse), so the
 * canvas isn't tainted and reading it back is allowed.
 */
import { useCallback, useEffect, useState } from 'react'

// Twice the widest a bookmark's picture is drawn, so it stays sharp on a 2×
// screen. A JPEG this size is a few KB.
const GRAB_W = 192

// Kept for the session, by file and moment: reopening the menu or switching
// tabs shouldn't grab the same frames again.
const grabbed = new Map<string, string>()
const keyOf = (src: string, time: number) => `${src}@${time}`

function once(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => { off(); resolve() }
    const bad = () => { off(); reject(new Error(`video ${event} failed`)) }
    const off = () => {
      video.removeEventListener(event, ok)
      video.removeEventListener('error', bad)
    }
    video.addEventListener(event, ok)
    video.addEventListener('error', bad)
  })
}

async function grab(video: HTMLVideoElement, time: number): Promise<string | null> {
  // Just short of the end: a seek to the very end can land past the last frame.
  video.currentTime = Math.max(0, Math.min(time, (video.duration || time) - 0.1))
  await once(video, 'seeked')
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null
  const canvas = document.createElement('canvas')
  canvas.width = GRAB_W
  canvas.height = Math.round((GRAB_W * vh) / vw)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.8))
  return blob ? URL.createObjectURL(blob) : null
}

/** The frame of `src` at each of `times`, as an image URL once it's been
 *  grabbed. Frames arrive one by one; a moment not grabbed yet reads as
 *  undefined. `src` null, or no times, grabs nothing. */
export function useFileFrames(src: string | null, times: number[]): (time: number) => string | undefined {
  const [version, setVersion] = useState(0)
  // Keyed on the moments asked for, not the ones still missing: each frame
  // grabbed shrinks that list, and restarting on it would load the file again
  // and grab the next frame twice.
  const sig = times.join(',')

  useEffect(() => {
    if (!src || !sig) return
    const wanted = sig.split(',').map(Number).filter((t) => !grabbed.has(keyOf(src, t)))
    if (!wanted.length) return
    let cancelled = false
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.src = src
    ;(async () => {
      try {
        await once(video, 'loadeddata')
        for (const time of wanted) {
          if (cancelled) return
          const url = await grab(video, time)
          if (cancelled) { if (url) URL.revokeObjectURL(url); return }
          if (url) {
            grabbed.set(keyOf(src, time), url)
            setVersion((v) => v + 1)
          }
        }
      } catch { /* no picture; the pin stands in */ }
    })()
    return () => {
      cancelled = true
      video.removeAttribute('src')
      video.load()
    }
  }, [src, sig])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((time: number) => (src ? grabbed.get(keyOf(src, time)) : undefined), [src, version])
}
