import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../lib/api'
import type { ReactNode } from 'react'
import type { VideoItem } from '../App'
import { ensureYTApi } from './VideoCard'
import SaveToPlaylist from './SaveToPlaylist'
import { useVolume, setAudioVolume } from '../hooks/audioStore'

type Props = {
  videoId: string
  // Metadata when we arrived from a card (renders instantly, no fetch flash).
  // Absent on a cold load / back-forward, where we fetch by id instead.
  video?: VideoItem | null
  onChannelClick: (channelId: string) => void
  onDownload: (video: VideoItem) => void
  isDownloaded: boolean
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function timeAgo(iso: string): string {
  const then = new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime()
  const hours = Math.floor((Date.now() - then) / 3_600_000)
  if (hours < 1) return 'Just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

// A timed caption cue from /feed/captions. `words` carries per-word timing (for
// auto-generated tracks) so we can reveal a line word-by-word; manual subs get a
// single word = the whole line.
type CaptionWord = { t: number; text: string }
type Cue = { start: number; dur: number; text: string; words?: CaptionWord[] }

// H:MM:SS, MM:SS, or M:SS timestamps in a description → clickable seeks.
const TIMESTAMP_RE = /(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)/g

/** Split a plain (non-URL) chunk, turning timestamps into seek buttons. */
function withTimestamps(text: string, keyBase: string, onSeek: (s: number) => void): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  TIMESTAMP_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TIMESTAMP_RE.exec(text)) !== null) {
    const [full, hh, mm, ss] = m
    const total = (hh ? Number(hh) * 3600 : 0) + Number(mm) * 60 + Number(ss)
    if (m.index > last) nodes.push(text.slice(last, m.index))
    nodes.push(
      <button
        key={`${keyBase}-${m.index}`}
        onClick={() => onSeek(total)}
        className="text-blue-400 hover:underline"
      >
        {full}
      </button>
    )
    last = m.index + full.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** Render a description with URLs as links and timestamps as seek buttons. */
function linkify(text: string, onSeek: (s: number) => void) {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noreferrer noopener"
        className="text-blue-400 hover:underline [overflow-wrap:anywhere]"
      >
        {part}
      </a>
    ) : (
      <span key={i}>{withTimestamps(part, String(i), onSeek)}</span>
    )
  )
}

export default function WatchPage({ videoId, video, onChannelClick, onDownload, isDownloaded }: Props) {
  const [meta, setMeta] = useState<VideoItem | null>(video ?? null)
  // Fetched separately and never stored server-side (see /api/feed/description).
  // Usually a cache hit: hovering the card already warmed it.
  const [description, setDescription] = useState('')
  const [embedError, setEmbedError] = useState(false)
  const [showSavePanel, setShowSavePanel] = useState(false)
  const saveRef = useRef<HTMLDivElement>(null)
  // Pinned (default): the player holds its place and only the details below
  // scroll. Unpinned: the whole page scrolls, so a tall video can move away.
  const [pinned, setPinned] = useState(true)
  // Set by the stall watchdog when an unmuted autoplay gets blocked (it doesn't
  // error — it wedges on a buffering spinner). Flipping this recreates the
  // player muted, which always plays. Resets per video (overlay is keyed by id).
  const [forcedMuted, setForcedMuted] = useState(false)
  // Our own captions, rendered from the transcript so we control position/size
  // (the embed's are locked inside the iframe). `c` toggles them; curTime drives
  // the word-by-word reveal. Resets per video (the overlay is keyed by id).
  const [captions, setCaptions] = useState<Cue[] | null>(null)
  const [showCaptions, setShowCaptions] = useState(false)
  const [curTime, setCurTime] = useState(0)
  // Transient volume HUD shown while adjusting with the keyboard, YouTube-style.
  const [volHint, setVolHint] = useState<{ vol: number; muted: boolean } | null>(null)
  const volHintTimer = useRef<number | undefined>(undefined)
  const showVolHint = (vol: number, muted: boolean) => {
    setVolHint({ vol, muted })
    if (volHintTimer.current) window.clearTimeout(volHintTimer.current)
    volHintTimer.current = window.setTimeout(() => setVolHint(null), 900)
  }
  useEffect(() => () => { if (volHintTimer.current) window.clearTimeout(volHintTimer.current) }, [])
  const hostRef = useRef<HTMLDivElement>(null)
  // The player box wraps the iframe AND our overlays (HUD, pin). It is both the
  // fullscreen target — so the HUD is inside the fullscreen layer and the video
  // still fills the screen — and the keyboard-focus target, so our shortcut
  // handler owns the keyboard instead of the cross-origin iframe (which would
  // otherwise swallow its own key events, in fullscreen especially).
  const playerBoxRef = useRef<HTMLDivElement>(null)
  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`

  // Share the preview volume: apply it to the watch player, follow live changes,
  // and mirror the player's own volume back so the value stays shared everywhere.
  const volume = useVolume()
  const volumeRef = useRef(volume)
  volumeRef.current = volume
  const playerRef = useRef<{
    setVolume: (v: number) => void
    getVolume: () => number
    isMuted: () => boolean
    mute: () => void
    unMute: () => void
    playVideo: () => void
    pauseVideo: () => void
    getPlayerState: () => number
    getCurrentTime: () => number
    seekTo: (seconds: number, allowSeekAhead: boolean) => void
  } | null>(null)

  // Jump to a description timestamp and play from there.
  const seekTo = (seconds: number) => {
    const p = playerRef.current
    if (!p) return
    p.seekTo(seconds, true)
    p.playVideo()
  }

  // Close the save-to-playlist popover on an outside click.
  useEffect(() => {
    if (!showSavePanel) return
    const onDown = (e: MouseEvent) => {
      if (saveRef.current && !saveRef.current.contains(e.target as Node)) setShowSavePanel(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showSavePanel])

  // Show whatever we arrived with instantly, then enrich from the endpoint
  // (description + fresh stats). On a cold load `video` is null and this is the
  // only source of metadata.
  useEffect(() => {
    setMeta(video ?? null)
    let cancelled = false
    apiFetch(`/api/feed/video/${videoId}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && d.youtube_id) setMeta(d) })
      .catch(() => { /* keep the card metadata / minimal chrome */ })
    return () => { cancelled = true }
  }, [videoId, video])

  useEffect(() => {
    setDescription('')
    let cancelled = false
    apiFetch(`/api/feed/description/${videoId}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setDescription(d?.description || '') })
      .catch(() => { /* no description box */ })
    return () => { cancelled = true }
  }, [videoId])

  // Prefetch the transcript so `c` toggles instantly. [] = no captions available.
  useEffect(() => {
    setCaptions(null)
    let cancelled = false
    apiFetch(`/api/feed/captions/${videoId}`, { quiet: true })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setCaptions(Array.isArray(d?.cues) ? d.cues : []) })
      .catch(() => { if (!cancelled) setCaptions([]) })
    return () => { cancelled = true }
  }, [videoId])

  // While captions are on, sample the play position to drive the word reveal.
  useEffect(() => {
    if (!showCaptions) return
    const id = window.setInterval(() => {
      const p = playerRef.current
      if (p) setCurTime(p.getCurrentTime())
    }, 120)
    return () => window.clearInterval(id)
  }, [showCaptions])

  // The caption lines to show now. Auto-caption cues overlap in time (the next
  // line starts while the previous is still up), which is how YouTube's rolling
  // 2-line effect is encoded — so we show EVERY cue spanning curTime, oldest
  // first, not just the latest. Each cue reveals its words up to the play head (a
  // hair of lookahead hides the 120ms poll lag). `wordByWord` marks a cue that
  // has per-word timing (auto captions): it reveals a word at a time, so it's
  // left-aligned (below) to keep appended words from shoving earlier ones. A cue
  // without per-word timing (manual subs) shows its whole line at once, so it's
  // centered like YouTube's manual captions.
  const captionLines = useMemo(() => {
    if (!showCaptions || !captions?.length) return []
    return captions
      .filter((c) => c.start <= curTime && curTime < c.start + c.dur)
      .sort((a, b) => a.start - b.start)
      .map((c) => {
        const wordByWord = !!c.words && c.words.length > 1
        const text = wordByWord
          ? c.words!.filter((w) => w.t <= curTime + 0.15).map((w) => w.text).join('').trim()
          : c.text
        return { text, wordByWord }
      })
      .filter((l) => l.text)
  }, [showCaptions, captions, curTime])

  // Create the full-size player. Opening the page is a click (a page gesture), so
  // we FIRST try unmuted autoplay — when the browser honors it, the video plays
  // with sound immediately (no muted-start, no audio-refetch spinner). But the
  // browser can still block it (no gesture on a cold load / refresh, or Chrome
  // deciding the origin lacks media engagement), and a blocked unmuted autoplay
  // doesn't error — it wedges on a buffering spinner. So a watchdog checks
  // whether playback actually started; if not, it recreates the player MUTED,
  // which always plays (unmute via the embed's speaker — that click is a real
  // gesture inside the iframe, so the audio loads properly).
  useEffect(() => {
    setEmbedError(false)
    const hasGesture = typeof navigator !== 'undefined' && navigator.userActivation
      ? navigator.userActivation.hasBeenActive
      : true
    const startMuted = !hasGesture || forcedMuted
    let player: { destroy: () => void } | null = null
    let cancelled = false
    let watchdog: number | undefined
    ensureYTApi().then(() => {
      if (cancelled || !hostRef.current) return
      // YT.Player replaces the node it's given with an iframe, so hand it a fresh
      // child that React never reconciles (mirrors the VideoCard preview pattern).
      const el = document.createElement('div')
      el.style.width = '100%'
      el.style.height = '100%'
      hostRef.current.innerHTML = ''
      hostRef.current.appendChild(el)
      player = new window.YT.Player(el, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 1, mute: startMuted ? 1 : 0, controls: 1, rel: 0, modestbranding: 1, playsinline: 1, fs: 1,
        },
        events: {
          onReady: (e) => {
            playerRef.current = e.target
            e.target.setVolume(volumeRef.current)
            // Focus the player box (not the iframe) so OUR shortcut handler
            // owns the keyboard from the start — including ArrowUp/Down for
            // volume, which the embedded iframe doesn't handle, and f/m, which
            // otherwise only work while the iframe holds focus.
            playerBoxRef.current?.focus()
            // Stall watchdog for the unmuted attempt: if we're not actually
            // PLAYING within 4s of ready, the autoplay was blocked → rebuild
            // muted rather than spinning forever.
            if (!startMuted) {
              const readyAt = Date.now()
              watchdog = window.setInterval(() => {
                const p = playerRef.current
                if (!p) return
                if (p.getPlayerState() === 1) { window.clearInterval(watchdog); return }
                if (Date.now() - readyAt > 4000) {
                  window.clearInterval(watchdog)
                  if (!cancelled) setForcedMuted(true)
                }
              }, 250)
            }
          },
          // 101 / 150 = embedding disabled by the uploader — fall back to YouTube.
          onError: () => { if (!cancelled) setEmbedError(true) },
        },
      })
    })
    return () => {
      cancelled = true
      if (watchdog) window.clearInterval(watchdog)
      playerRef.current = null
      try { player?.destroy() } catch { /* already gone */ }
      if (hostRef.current) hostRef.current.innerHTML = ''
    }
  }, [videoId, forcedMuted])

  // Store → player: apply shared-volume changes to a live player.
  useEffect(() => { playerRef.current?.setVolume(volume) }, [volume])

  // Player → store: if you change volume with the embed's own control, push it
  // back so previews follow. (No update while muted — that shouldn't zero it.)
  useEffect(() => {
    const id = setInterval(() => {
      const p = playerRef.current
      if (!p || p.isMuted()) return
      const v = Math.round(p.getVolume())
      if (v >= 0 && v !== volumeRef.current) setAudioVolume(v)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // Player keyboard shortcuts, handled at the window level so they work wherever
  // focus is on the page (the details below, the action pills, empty space) —
  // not only while the cross-origin iframe holds focus. We drive the player
  // through the IFrame API and preventDefault so keys don't scroll the page.
  //
  // ArrowUp/Down (volume) is implemented here on purpose: YouTube's *embedded*
  // iframe doesn't bind them to volume the way youtube.com does, so focusing the
  // video can't help — we adjust the shared volume ourselves. (Any of these can
  // only fire while focus isn't trapped inside the iframe, since a cross-origin
  // iframe swallows its own key events; that's why we focus the container above.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
        || (t instanceof HTMLElement && t.isContentEditable)) return
      const p = playerRef.current
      if (!p) return
      const k = e.key
      if (e.code === 'Space' || k === 'k') {
        e.preventDefault()
        if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo()
      } else if (k === 'm') {
        e.preventDefault()
        const willMute = !p.isMuted()
        if (willMute) p.mute(); else p.unMute()
        showVolHint(volumeRef.current, willMute)
      } else if (k === 'f') {
        e.preventDefault()
        // Fullscreen OUR box, not the iframe. A fullscreen cross-origin iframe
        // traps keyboard focus (our shortcuts die, YouTube's native ones take
        // over) and still doesn't give a clean pause — so the box wins: our
        // overlays and shortcuts keep working, at the cost of YouTube's inline
        // pause UI showing the control bar.
        if (document.fullscreenElement) document.exitFullscreen()
        else playerBoxRef.current?.requestFullscreen?.()
      } else if (k === 'ArrowUp' || k === 'ArrowDown') {
        e.preventDefault()
        const next = Math.max(0, Math.min(100, Math.round(volumeRef.current + (k === 'ArrowUp' ? 5 : -5))))
        if (k === 'ArrowUp' && p.isMuted()) p.unMute()  // raising volume unmutes, like YouTube
        volumeRef.current = next  // update now so key-repeat bursts accumulate (ref lags a render)
        setAudioVolume(next)  // shared store → applies to the player and previews
        showVolHint(next, k !== 'ArrowUp' && p.isMuted())
      } else if (k === 'c') {
        // Toggle OUR caption overlay (rendered from the transcript). YouTube's
        // native `c` only works while the iframe is focused, which we avoid.
        e.preventDefault()
        setShowCaptions((v) => !v)
      } else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'j' || k === 'l') {
        e.preventDefault()
        const step = (k === 'j' || k === 'l' ? 10 : 5) * (k === 'ArrowLeft' || k === 'j' ? -1 : 1)
        p.seekTo(Math.max(0, p.getCurrentTime() + step), true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Keep the keyboard on our handler even after the user clicks the video.
  // Clicking a cross-origin iframe moves focus into it, and it then swallows its
  // own key events — so ArrowUp/Down (and f/m) would stop working. When we see
  // the iframe has taken focus, pull it back to the player box; the click's own
  // action (play/pause) has already happened. This runs in fullscreen too — the
  // player box IS the fullscreen element, so refocusing it is allowed and is
  // what lets `f` reliably exit after a click landed in the video.
  useEffect(() => {
    const onBlur = () => {
      window.setTimeout(() => {
        const iframe = hostRef.current?.querySelector('iframe')
        if (iframe && document.activeElement === iframe) playerBoxRef.current?.focus()
      }, 0)
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

  // A video's captions are all one kind (the backend picks a single track), so
  // if none are word-by-word they're manual subs — centered and free to use the
  // full width. Word-by-word needs the fixed narrow box for its stable left edge.
  const manualCaptions = captionLines.length > 0 && captionLines.every((l) => !l.wordByWord)

  // The caption + volume overlays. Rendered inside the player box, which is also
  // the fullscreen target, so they show in both windowed and fullscreen modes.
  const overlays = (
    <>
      {/* Caption overlay — from the transcript, cloning YouTube's rolling
          captions: per-line rgba(8,8,8,.75) box hugging the text, white
          sans-serif scaled to the player, stacked oldest-on-top, LEFT-aligned in
          a fixed-width box so a building line grows without shoving earlier
          words, and bottom-anchored so new lines push the stack upward. */}
      {showCaptions && captionLines.length > 0 && (
        <div
          className="pointer-events-none absolute inset-x-0 z-10 flex justify-center px-[5%]"
          // Sit above the control bar. 11% of the player height tracks the bar
          // on big players, but on a short player the embed scales the bar UP
          // ("big mode"), so it dips into 11% — the 5.5rem floor clears the
          // scrubber (measured ~73px above the bottom on a 281px-tall player).
          style={{ bottom: 'max(11%, 5.5rem)' }}
        >
          <div
            style={{
              // Manual (centered) captions use the full width; word-by-word gets
              // a fixed ≈40-char box so its left edge stays put as words append.
              width: manualCaptions ? '100%' : 'min(90%, 20em)',
              // Measured from youtube.com's own player: 2.5%-of-width font,
              // weight 400, normal line-height, its exact font stack.
              fontFamily: '"YouTube Noto", Roboto, Arial, Helvetica, Verdana, "PT Sans Caption", sans-serif',
              fontSize: '2.5cqw',
              fontWeight: 400,
              lineHeight: 'normal',
              // YouTube renders captions with grayscale smoothing, which on
              // macOS looks lighter than the default subpixel — a big part of
              // why ours read as "bolder".
              WebkitFontSmoothing: 'antialiased',
              MozOsxFontSmoothing: 'grayscale',
            }}
          >
            {captionLines.map((line, i) => (
              // display:flex blockifies the span so its background fills the whole
              // line box (leading included) — stacked lines then abut with no gap,
              // like YouTube. Word-by-word lines pin left (justify-start) so
              // appended words don't shift; whole-line (manual) captions center.
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: line.wordByWord ? 'flex-start' : 'center',
                }}
              >
                <span
                  style={{
                    color: '#fff',
                    background: 'rgba(8, 8, 8, 0.75)',
                    padding: '0 0.25em',  // YouTube: 0 vertical, ~6px horizontal
                    textAlign: line.wordByWord ? 'left' : 'center',
                  }}
                >
                  {line.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Volume HUD — a brief overlay while adjusting volume / mute by keyboard. */}
      {volHint && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 text-white shadow-lg">
          <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            {volHint.muted || volHint.vol === 0 ? (
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3 2.7-2.7a1 1 0 0 0-1.4-1.4L14.1 10.6l-.1.1V13.4l2.9 2.9a1 1 0 0 0 1.4-1.4L16.5 12z" />
            ) : (
              <path d="M3 9v6h4l5 5V4L7 9H3zm11.5 3a4 4 0 0 0-2.2-3.6v7.2A4 4 0 0 0 14.5 12z" />
            )}
          </svg>
          {volHint.muted ? (
            <span className="text-sm font-medium">Muted</span>
          ) : (
            <>
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/25">
                <div className="h-full rounded-full bg-white" style={{ width: `${volHint.vol}%` }} />
              </div>
              <span className="w-9 text-right text-sm font-medium tabular-nums">{volHint.vol}%</span>
            </>
          )}
        </div>
      )}
    </>
  )

  return (
    // Pinned: a fixed column where the player stays put and the details scroll on
    // their own. Unpinned: a plain block, so the overlay scrolls the whole thing.
    <div className={pinned ? 'flex h-full flex-col' : 'w-full'}>
      {/* Full-bleed player: full width, square corners, no side padding. Keeps its
          natural 16:9 height in both modes (shrink-0 so the flex column can't
          squash it while pinned). Focusable + the fullscreen target (see refs). */}
      <div
        ref={playerBoxRef}
        tabIndex={-1}
        // container-type so captions can size by player width (2.5cqw ≈ YouTube's
        // 2.5%-of-player-width caption size), matching at any player scale.
        style={{ containerType: 'inline-size' }}
        className={`relative w-full bg-black outline-none aspect-video [&:fullscreen]:aspect-auto ${pinned ? 'shrink-0' : ''}`}
      >
        <div ref={hostRef} className="absolute inset-0" />

        {/* Caption + volume-HUD overlays (defined above). They stay inside the
            box, which is also the fullscreen target, so they show in fullscreen. */}
        {overlays}

        {/* Pin toggle, bottom-right corner — equal 8px gap on the bottom and
            right, sat on the button-row line so it clears the progress scrubber. */}
        <button
          onClick={() => setPinned((p) => !p)}
          className="absolute bottom-2 right-2 z-20 rounded-full bg-black/60 p-2 text-white hover:bg-black/80 transition-colors"
          title={pinned ? 'Unpin — scroll the whole page' : 'Pin — keep the video in view'}
          aria-pressed={pinned}
        >
          {pinned ? (
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 3a1 1 0 0 1 .117 1.993L16 5v4.764l1.447 2.895c.55 1.098-.2 2.38-1.41 2.34L16 15h-3v5a1 1 0 0 1-1.993.117L11 20v-5H8c-1.23.05-2.02-1.2-1.51-2.28l.063-.125L8 9.764V5a1 1 0 0 1-.117-1.993L8 3h8z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v5M8 9.5V5h8v4.5l1.5 3H6.5L8 9.5z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4l16 16" />
            </svg>
          )}
        </button>

        {embedError && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/95 px-6 text-center">
            <p className="text-sm text-[#aaa]">This video can’t be played in-app (the uploader disabled embedding).</p>
            <a
              href={youtubeUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 transition-colors"
            >
              Open on YouTube
            </a>
          </div>
        )}
      </div>

      {/* Details. While pinned this is the only scroll region (min-h-0 lets it
          shrink inside the flex column); the title, meta row, and description all
          scroll together. Unpinned, it's plain flow and the page scrolls. */}
      <div className={pinned ? 'min-h-0 flex-1 overflow-y-auto' : ''}>

      {/* Metadata — padded + width-limited for readability under the full player. */}
      <div className="max-w-[1100px] px-4 py-4 md:px-6">
        <h1 className="text-lg md:text-xl font-semibold leading-snug text-white [overflow-wrap:anywhere]">
          {meta?.title ?? '…'}
        </h1>
        {/* Stats on the left, action pills on the right of the same row. */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[#aaa]">
            {meta && (
              <>
                {meta.channel_thumbnail && (
                  <a
                    href={`/channel/${meta.channel_id}`}
                    onClick={(e) => { e.preventDefault(); onChannelClick(meta.channel_id) }}
                    className="flex-shrink-0"
                    title={meta.channel_name || 'Channel'}
                  >
                    <img
                      src={meta.channel_thumbnail}
                      alt=""
                      className="w-8 h-8 rounded-full object-cover bg-[#3a3a3a]"
                    />
                  </a>
                )}
                <a
                  href={`/channel/${meta.channel_id}`}
                  onClick={(e) => { e.preventDefault(); onChannelClick(meta.channel_id) }}
                  className="font-medium text-white hover:text-blue-400 transition-colors"
                >
                  {meta.channel_name || 'Unknown'}
                </a>
                <span className="text-[#444]">·</span>
                <span>{formatCount(meta.view_count)} views</span>
                <span className="text-[#444]">·</span>
                <span>{timeAgo(meta.published_at)}</span>
                {meta.view_count > 0 && (
                  <>
                    <span className="text-[#444]">·</span>
                    <span>{formatCount(meta.like_count)} likes</span>
                  </>
                )}
              </>
            )}
          </div>

          {/* Action pills — Save to playlist / Download, mirroring the card menu. */}
          {meta && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative" ref={saveRef}>
              <button
                onClick={() => setShowSavePanel((o) => !o)}
                className="flex items-center gap-2 rounded-full bg-[#272727] px-4 py-2 text-sm font-medium text-white hover:bg-[#3f3f3f] transition-colors"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
                </svg>
                Save
              </button>
              {showSavePanel && (
                <div className="absolute left-0 top-full mt-2 z-40 rounded-xl bg-[#282828] shadow-2xl ring-1 ring-white/10 py-2">
                  <SaveToPlaylist video={meta} onBack={() => setShowSavePanel(false)} />
                </div>
              )}
            </div>

            <button
              onClick={() => onDownload(meta)}
              disabled={isDownloaded}
              className="flex items-center gap-2 rounded-full bg-[#272727] px-4 py-2 text-sm font-medium text-white hover:bg-[#3f3f3f] transition-colors disabled:opacity-50 disabled:hover:bg-[#272727]"
            >
              {isDownloaded ? (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                </svg>
              )}
              {isDownloaded ? 'Downloaded' : 'Download'}
            </button>
            </div>
          )}
        </div>

        {/* This video's topics — the channel-page labels derived from its title. */}
        {meta?.title_labels && meta.title_labels.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {meta.title_labels.map((label) => (
              <span
                key={label}
                className="inline-flex items-center rounded-full bg-[#272727] px-2.5 py-1 text-xs text-[#ddd]"
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {/* No own scroll here: the details wrapper above owns scrolling, so the
            description flows at full height and scrolls with the rest. */}
        {description && (
          <div className="mt-4 whitespace-pre-wrap rounded-xl bg-[#1a1a1a] p-4 text-sm leading-relaxed text-[#ccc] [overflow-wrap:anywhere]">
            {linkify(description, seekTo)}
          </div>
        )}
        </div>
      </div>
    </div>
  )
}
