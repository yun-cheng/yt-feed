import { useEffect, useRef, useState } from 'react'
import type { VideoItem } from '../App'
import { ensureYTApi } from './VideoCard'
import { useVolume, setAudioVolume } from '../hooks/audioStore'

type Props = {
  videoId: string
  // Metadata when we arrived from a card (renders instantly, no fetch flash).
  // Absent on a cold load / back-forward, where we fetch by id instead.
  video?: VideoItem | null
  onChannelClick: (channelId: string) => void
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

/** Render a description as text with its URLs turned into links. */
function linkify(text: string) {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noreferrer noopener"
        // Following a link shouldn't also expand the box behind it.
        onClick={(e) => e.stopPropagation()}
        className="text-blue-400 hover:underline [overflow-wrap:anywhere]"
      >
        {part}
      </a>
    ) : (
      part
    )
  )
}

function Description({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const [clipped, setClipped] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Only offer the toggle when the text actually overflows the clamp.
  useEffect(() => {
    const el = bodyRef.current
    if (el) setClipped(el.scrollHeight > el.clientHeight + 1)
  }, [text])

  // While collapsed, the whole box expands on click (YouTube does the same).
  // Collapsing again is the button's job only, so a click inside long text can't
  // yank it shut under you.
  const expandOnClick = clipped && !expanded

  return (
    <div
      onClick={expandOnClick ? () => {
        // A click that ends a text selection is a drag, not an expand.
        if (window.getSelection()?.toString()) return
        setExpanded(true)
      } : undefined}
      className={`mt-4 rounded-xl bg-[#1a1a1a] p-4 text-sm leading-relaxed text-[#ccc] transition-colors ${
        expandOnClick ? 'cursor-pointer hover:bg-[#222]' : ''
      }`}
    >
      <div
        ref={bodyRef}
        className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${expanded ? '' : 'line-clamp-4'}`}
      >
        {linkify(text)}
      </div>
      {(clipped || expanded) && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
          className="mt-2 font-medium text-white hover:text-blue-400 transition-colors"
        >
          {expanded ? 'Show less' : '...more'}
        </button>
      )}
    </div>
  )
}

export default function WatchPage({ videoId, video, onChannelClick }: Props) {
  const [meta, setMeta] = useState<VideoItem | null>(video ?? null)
  // Fetched separately and never stored server-side (see /api/feed/description).
  // Usually a cache hit: hovering the card already warmed it.
  const [description, setDescription] = useState('')
  const [embedError, setEmbedError] = useState(false)
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
  } | null>(null)

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
    <div className="w-full">
      {/* Full-bleed player: full width, square corners, no side padding. Height
          capped so the metadata below stays reachable on a wide screen. */}
      <div className="relative w-full aspect-video max-h-[calc(100vh-4rem)] bg-black">
        <div ref={hostRef} className="absolute inset-0" />

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

      {/* Metadata — padded + width-limited for readability under the full player. */}
      <div className="max-w-[1100px] px-4 py-4 md:px-6">
        <h1 className="text-lg md:text-xl font-semibold leading-snug text-white [overflow-wrap:anywhere]">
          {meta?.title ?? '…'}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[#aaa]">
          {meta && (
            <>
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

        {description && <Description text={description} />}
      </div>
    </div>
  )
}
