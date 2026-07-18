import { useEffect, useRef, useState } from 'react'
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
  const hostRef = useRef<HTMLDivElement>(null)
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
    playVideo: () => void
    pauseVideo: () => void
    getPlayerState: () => number
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
    fetch(`/api/feed/video/${videoId}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && d.youtube_id) setMeta(d) })
      .catch(() => { /* keep the card metadata / minimal chrome */ })
    return () => { cancelled = true }
  }, [videoId, video])

  useEffect(() => {
    setDescription('')
    let cancelled = false
    fetch(`/api/feed/description/${videoId}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setDescription(d?.description || '') })
      .catch(() => { /* no description box */ })
    return () => { cancelled = true }
  }, [videoId])

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
            // Focus the player so its own keyboard shortcuts (space, arrows, f)
            // work immediately without a click.
            hostRef.current?.querySelector('iframe')?.focus()
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

  // Space / k toggles play-pause. The embed handles this itself while focused;
  // this covers the case where focus has moved off the iframe (so Space would
  // otherwise just scroll the page). Ignored while typing in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code !== 'Space' && e.key !== 'k') return
      const p = playerRef.current
      if (!p) return
      e.preventDefault()
      if (p.getPlayerState() === 1) p.pauseVideo()
      else p.playVideo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    // Pinned: a fixed column where the player stays put and the details scroll on
    // their own. Unpinned: a plain block, so the overlay scrolls the whole thing.
    <div className={pinned ? 'flex h-full flex-col' : 'w-full'}>
      {/* Full-bleed player: full width, square corners, no side padding. Keeps its
          natural 16:9 height in both modes (shrink-0 so the flex column can't
          squash it while pinned). */}
      <div className={`relative w-full bg-black aspect-video ${pinned ? 'shrink-0' : ''}`}>
        <div ref={hostRef} className="absolute inset-0" />

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
