import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import type { VideoItem } from '../App'
import { useVolume, setAudioVolume } from '../hooks/audioStore'
import SaveToPlaylist from './SaveToPlaylist'

// Minimal YT IFrame API types
declare global {
  interface Window {
    YT: { Player: new (el: HTMLElement, cfg: YTPlayerConfig) => YTPlayerInstance }
    onYouTubeIframeAPIReady?: () => void
  }
}
interface YTPlayerConfig {
  videoId?: string
  width?: string | number
  height?: string | number
  playerVars?: Record<string, unknown>
  events?: {
    onReady?: (e: { target: YTPlayerInstance }) => void
    onStateChange?: (e: { data: number; target: YTPlayerInstance }) => void
    onApiChange?: (e: { target: YTPlayerInstance }) => void
    onError?: (e: { data: number; target: YTPlayerInstance }) => void
  }
}
interface YTPlayerInstance {
  playVideo(): void
  pauseVideo(): void
  seekTo(s: number, allow: boolean): void
  mute(): void
  unMute(): void
  isMuted(): boolean
  setVolume(volume: number): void
  getVolume(): number
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  loadModule(name: string): void
  unloadModule(name: string): void
  getOptions(): string[]
  getOption(module: string, key: string): unknown
  setOption(module: string, key: string, value: unknown): void
  destroy(): void
}

let _ytReady = false
const _ytQ: Array<() => void> = []
export function ensureYTApi(): Promise<void> {
  return new Promise(resolve => {
    if (_ytReady) return resolve()
    // After HMR, _ytReady resets but window.YT may already be loaded
    if (window.YT?.Player) { _ytReady = true; return resolve() }
    _ytQ.push(resolve)
    if (!document.getElementById('yt-api-script')) {
      const s = document.createElement('script')
      s.id = 'yt-api-script'
      s.src = 'https://www.youtube.com/iframe_api'
      document.head.appendChild(s)
    }
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      _ytReady = true
      _ytQ.splice(0).forEach(cb => cb())
      prev?.()
    }
  })
}

// Warm the YouTube IFrame API early (call once on app start) so the very first
// hover doesn't also wait on this script download before it can create a player.
export function preloadYouTubeApi() {
  ensureYTApi()
}

type StoryboardInfo = {
  rows: number
  cols: number
  frame_width: number
  frame_height: number
  fragment_urls: string[]
  fragment_duration: number
}

// A single timed caption cue (seconds) from /feed/captions
type Cue = { start: number; dur: number; text: string }

// Wrap a native <video> so it exposes the same surface as a YT player instance —
// lets the whole preview/controls/seek/volume machinery below run unchanged whether
// the source is a YouTube embed or a locally downloaded file.
function makeVideoAdapter(v: HTMLVideoElement): YTPlayerInstance {
  return {
    playVideo: () => { v.play().catch(() => {}) },
    pauseVideo: () => v.pause(),
    seekTo: (s) => { v.currentTime = s },
    mute: () => { v.muted = true },
    unMute: () => { v.muted = false },
    isMuted: () => v.muted,
    setVolume: (vol) => { v.volume = Math.max(0, Math.min(1, vol / 100)) },
    getVolume: () => v.volume * 100,
    getCurrentTime: () => v.currentTime || 0,
    getDuration: () => v.duration || 0,
    // 1 = playing, 2 = paused (matches YT's PlayerState enough for our checks).
    getPlayerState: () => (!v.paused && !v.ended && v.currentTime > 0 ? 1 : 2),
    loadModule: () => {},
    unloadModule: () => {},
    getOptions: () => [],
    getOption: () => undefined,
    setOption: () => {},
    destroy: () => { v.pause(); v.removeAttribute('src'); v.load(); v.remove() },
  }
}

type Props = {
  video: VideoItem
  isHovered: boolean
  onHover: (id: string | null) => void
  onChannelClick: (channelId: string) => void
  sort?: string
  isWatchLater?: boolean
  onToggleWatchLater?: (video: VideoItem) => void
  onDownload?: (video: VideoItem) => void
  isDownloaded?: boolean
  onOpen?: (video: VideoItem) => void            // overrides the default "open on YouTube" click
  onRemoveDownload?: (video: VideoItem) => void  // when set, the menu shows "remove download"
  onRemoveFromPlaylist?: (video: VideoItem) => void  // when set (playlist page), the menu shows "remove from playlist"
  onHideChannel?: (channelId: string) => void    // when set, the menu shows "hide channel from home"
  localSrc?: string                              // preview a local file instead of the YouTube embed
  localOnly?: boolean                            // never fall back to YouTube; wait for localSrc (offline)
}

function formatViewCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

function formatDuration(s: number): string {
  if (!s || s <= 0) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

function timeAgo(iso: string): string {
  const now = Date.now()
  const then = new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime()
  const hours = Math.floor((now - then) / 3600000)
  if (hours < 1) return 'Just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

// Scale down frames so preview fits in small cards
const SB_SCALE = 0.5

function getStoryboardFrame(sb: StoryboardInfo, time: number) {
  const framesPerSheet = sb.rows * sb.cols
  const totalFrames = framesPerSheet * sb.fragment_urls.length
  const frameDuration = (sb.fragment_duration * sb.fragment_urls.length) / totalFrames
  const frame = Math.max(0, Math.min(totalFrames - 1, Math.floor(time / frameDuration)))
  const sheetIdx = Math.floor(frame / framesPerSheet)
  const posInSheet = frame % framesPerSheet
  const col = posInSheet % sb.cols
  const row = Math.floor(posInSheet / sb.cols)
  const fw = sb.frame_width * SB_SCALE
  const fh = sb.frame_height * SB_SCALE
  return {
    url: sb.fragment_urls[sheetIdx] ?? sb.fragment_urls[0],
    bgX: -col * fw,
    bgY: -row * fh,
    fw,
    fh,
    sheetW: sb.cols * fw,
    sheetH: sb.rows * fh,
  }
}

// Shared circle-button sizes so bookmark / mute / CC all match
const BTN = 'p-2 rounded-full transition-colors'
const BTN_DARK = `${BTN} bg-black/60 text-white hover:bg-black/80`
const BTN_LIGHT = `${BTN} bg-white/90 text-black hover:bg-white`

// Per-video caption preference for THIS page load (module-level = survives a card
// remount / re-hover, but resets on refresh). Captions default ON; toggling off a
// specific video is remembered here so re-hovering it keeps them off.
const ccPrefByVideo = new Map<string, boolean>()

// How long a player stays alive after the cursor leaves before it's destroyed.
// Long enough that flicking back to the card keeps it warm; short enough that
// idle players (and their audio) don't linger.
const PLAYER_IDLE_TEARDOWN_MS = 600

export default function VideoCard({ video, isHovered, onHover, onChannelClick, sort, isWatchLater, onToggleWatchLater, onDownload, isDownloaded, onOpen, onRemoveDownload, onRemoveFromPlaylist, onHideChannel, localSrc, localOnly }: Props) {
  const videoUrl = `https://www.youtube.com/watch?v=${video.youtube_id}`
  // Shorts render as a vertical (9:16) card — YouTube's native Shorts ratio —
  // instead of 16:9 landscape.
  const isShort = !!video.is_short
  // Landscape cards look sharp at mqdefault (320×180). A Short fills a tall 9:16
  // card, so a 16:9 mqdefault would be centre-cropped and upscaled ~2× (blurry).
  // Use sddefault (640×480) — reliably present and high enough res that the
  // centre-cropped strip stays sharp — with mqdefault as the always-present
  // last resort (onError / 120×90-placeholder onLoad fall through below).
  const shortThumbs = useMemo(() => [
    `https://i.ytimg.com/vi/${video.youtube_id}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${video.youtube_id}/mqdefault.jpg`,
  ], [video.youtube_id])
  const [shortThumbIdx, setShortThumbIdx] = useState(0)
  const thumb = isShort
    ? shortThumbs[Math.min(shortThumbIdx, shortThumbs.length - 1)]
    : (video.thumbnail_url?.replace('hqdefault', 'mqdefault') || '')

  const playerRef = useRef<YTPlayerInstance | null>(null)
  const playerReadyRef = useRef(false)
  const playerWrapperRef = useRef<HTMLDivElement>(null)
  const playerCreatedRef = useRef(false)
  const progressBarRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)
  const scrubVideoRef = useRef<HTMLVideoElement>(null)  // local-file scrubbing thumbnail

  // Volume is shared+persisted; MUTE is per-video (see audioStore). Every preview
  // starts muted; clicking the video unmutes just that one.
  const volume = useVolume()
  const volumeRef = useRef(volume)
  volumeRef.current = volume
  // Captions default ON, unless this video was explicitly turned off this session.
  const [showCaptions, setShowCaptions] = useState(() => ccPrefByVideo.get(video.youtube_id) ?? true)
  const [captions, setCaptions] = useState<Cue[] | null>(null)
  const captionsFetchedRef = useRef(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(video.duration_seconds > 0 ? video.duration_seconds : 0)
  const [hoverRatio, setHoverRatio] = useState<number | null>(null)
  // Keep the thumbnail up until the preview is actually playing — the YouTube
  // embed takes ~1-2s to load, and hiding the thumbnail on hover would leave a
  // blank card during that gap. Flips true on the player's first PLAYING state.
  const [playing, setPlaying] = useState(false)
  // This preview's mute state. Previews always start muted; `actualMuted` mirrors
  // the player's real state (polled) so the speaker icon can never show "sound on"
  // while actually silent. null until the first player exists → treated as muted.
  const [actualMuted, setActualMuted] = useState<boolean | null>(null)
  const stallSinceRef = useRef<number | null>(null)   // when the preview stopped progressing
  const fallbackTriedRef = useRef(false)              // one muted-rebuild rescue per hover
  // Set when you click to unmute before the preview has finished loading — the
  // unmute is applied the moment it starts playing (see createPlayer's PLAYING).
  const wantsUnmuteRef = useRef(false)
  // What the sound controls show/toggle. Defaults muted (every preview starts muted).
  const displayMuted = actualMuted ?? true
  const [storyboard, setStoryboard] = useState<StoryboardInfo | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)   // title "more actions" menu
  const [showSavePanel, setShowSavePanel] = useState(false)  // "save to playlist" sub-panel
  const menuRef = useRef<HTMLDivElement>(null)

  const currentTimeRef = useRef(currentTime)
  useEffect(() => { currentTimeRef.current = currentTime }, [currentTime])
  const durationRef = useRef(duration)
  useEffect(() => { durationRef.current = duration }, [duration])
  // Latest hover state for async callbacks (player onReady may fire after the user
  // has already moved on to another card — see the guard in createPlayer's onReady).
  const isHoveredRef = useRef(isHovered)
  isHoveredRef.current = isHovered

  const seekFromX = (clientX: number) => {
    if (!progressBarRef.current || durationRef.current <= 0) return
    const rect = progressBarRef.current.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const seekTime = ratio * durationRef.current
    setCurrentTime(seekTime)
    playerRef.current?.seekTo(seekTime, true)
  }
  const seekFromXRef = useRef(seekFromX)
  seekFromXRef.current = seekFromX

  // Shared player-creation logic — called on first hover and on CC toggle.
  // The container div is created imperatively so React never reconciles it —
  // if we let React own the target element, re-renders replace the YT-generated
  // iframe with the original div, leaving audio playing but nothing visible.
  const createPlayer = useCallback((seekTime?: number) => {
    if (!playerWrapperRef.current) return
    playerCreatedRef.current = true

    // ALWAYS start muted. Muted autoplay is the only kind browsers reliably allow
    // (an unmuted autoplay without a fresh gesture just wedges buffering). The
    // user unmutes a specific preview by CLICKING it — that click is the gesture
    // the autoplay policy needs, so unmuting an already-playing muted video is
    // reliable (see handleVideoActivate). Nothing here ever auto-unmutes.
    setActualMuted(true)

    // Local downloaded file: play it directly (offline, no YouTube network).
    if (localSrc) {
      const v = document.createElement('video')
      v.src = localSrc
      v.loop = true
      v.playsInline = true
      v.preload = 'auto'   // buffer the whole local file so scrubbing works offline
      v.muted = true
      v.volume = volumeRef.current / 100
      v.style.width = '100%'
      v.style.height = '100%'
      v.style.objectFit = 'cover'
      playerWrapperRef.current.appendChild(v)
      const adapter = makeVideoAdapter(v)
      const onReady = () => {
        if (!playerWrapperRef.current || !playerWrapperRef.current.contains(v)) return
        playerRef.current = adapter
        playerReadyRef.current = true
        if (v.duration) setDuration(v.duration)
        if (seekTime && seekTime > 0) v.currentTime = seekTime
        if (isHoveredRef.current) v.play().catch(() => {})
        else v.pause()
      }
      v.addEventListener('loadedmetadata', onReady, { once: true })
      v.addEventListener('playing', () => {
        // Same race guard as the YouTube path: if playback begins after the
        // cursor already left, pause instead of leaking audio.
        if (!isHoveredRef.current) { v.pause(); return }
        setPlaying(true)  // reveal video over thumbnail (starts muted; click to unmute)
      })
      return
    }

    const container = document.createElement('div')
    container.style.width = '100%'
    container.style.height = '100%'
    playerWrapperRef.current.appendChild(container)
    ensureYTApi().then(() => {
      // If cleanup removed container from DOM (StrictMode double-mount), skip
      if (!playerWrapperRef.current || !playerWrapperRef.current.contains(container)) return
      new window.YT.Player(container, {
        videoId: video.youtube_id,
        width: '100%',
        height: '100%',
        playerVars: {
          // autoplay:0 — we start playback explicitly in onReady (only if still
          // hovered), so a video loaded then abandoned never emits sound.
          // mute:1 always — every preview starts muted; the user unmutes by
          // clicking the video (see handleVideoActivate).
          autoplay: 0, mute: 1, controls: 0, rel: 0, loop: 1,
          playlist: video.youtube_id, iv_load_policy: 3,
          fs: 0, disablekb: 1, playsinline: 1, modestbranding: 1,
          // We render captions ourselves from the /feed/captions transcript
          // (see the caption overlay below), so YouTube's own captions stay off —
          // its embedded rendering is tiny and unreliable inside a cropped embed.
          // controls:0 removes the controls bar; the symmetric over-scan on the
          // wrapper hides the remaining top/bottom chrome (share, logo, etc.).
          // pointer-events:none on the wrapper prevents the hover overlay.
        },
        events: {
          onReady: (e) => {
            // Only expose the player after it's fully initialized
            playerRef.current = e.target
            playerReadyRef.current = true
            const iframe = playerWrapperRef.current?.querySelector('iframe')
            if (iframe) {
              iframe.style.width = '100%'
              iframe.style.height = '100%'
              iframe.style.border = 'none'
            }
            // Muted start; volume pre-set so a later click-to-unmute is audible.
            e.target.setVolume(volumeRef.current)
            e.target.mute()
            if (seekTime && seekTime > 0) e.target.seekTo(seekTime, true)
            // The user may have already hovered away while the player was loading
            // (autoplay:1 would otherwise start it, sound and all) — only play if
            // this card is still the hovered one; otherwise pause immediately.
            if (isHoveredRef.current) e.target.playVideo()
            else e.target.pauseVideo()
          },
          onStateChange: (e) => {
            // 1 === PLAYING.
            if (e.data === 1) {
              // Race guard: pauseVideo() issued while the player is still buffering
              // is dropped by YouTube, so a preview abandoned mid-load can start
              // playing — with sound — after the cursor already left (the wrapper is
              // only display:none, which doesn't stop iframe audio). If we're no
              // longer hovered when playback actually begins, pause it now.
              if (!isHoveredRef.current) { e.target.pauseVideo(); return }
              // You clicked to unmute before this finished loading — apply it now
              // that it's actually playing (see handleVideoActivate).
              if (wantsUnmuteRef.current) {
                wantsUnmuteRef.current = false
                e.target.unMute()
                setActualMuted(false)
              }
              // Muted start always plays — reveal the video (hide the thumbnail)
              // as soon as frames render. No audio transition to wait on.
              setPlaying(true)
            }
          },
        },
      })
    })
  }, [video.youtube_id, localSrc])

  useEffect(() => {
    if (!isHovered || playerCreatedRef.current) return
    if (localOnly && !localSrc) return  // download card: wait for the in-memory blob URL
    createPlayer()
  }, [isHovered, localOnly, localSrc, createPlayer])

  // Pause/resume on hover change
  useEffect(() => {
    if (!playerRef.current) return
    if (isHovered) playerRef.current.playVideo()
    else playerRef.current.pauseVideo()
  }, [isHovered])

  // Apply the shared volume to this card's player whenever it changes. Every
  // mounted card runs this, so changing the volume on one preview updates them
  // all. Mute is per-card and driven by the click/button handlers, not here.
  useEffect(() => {
    const p = playerRef.current
    if (!p || !playerReadyRef.current) return
    p.setVolume(volume)
  }, [volume])

  // Fully dispose this card's player and reset its flags so a later hover
  // recreates it cleanly. Called on unmount, after the idle window below, and by
  // the stall watchdog before a muted rebuild.
  const teardownPlayer = useCallback(() => {
    try { playerRef.current?.destroy() } catch { /* already gone */ }
    playerRef.current = null
    playerReadyRef.current = false
    playerCreatedRef.current = false
    if (playerWrapperRef.current) playerWrapperRef.current.innerHTML = ''
  }, [])

  // Poll currentTime/duration while hovered, mirror the player's real mute state
  // into the icon, and watch for a stalled preview.
  useEffect(() => {
    if (!isHovered) return
    const id = setInterval(() => {
      const p = playerRef.current
      if (!p) return
      const t = p.getCurrentTime()
      const d = p.getDuration()
      if (typeof t === 'number') setCurrentTime(t)
      if (typeof d === 'number' && d > 0) setDuration(d)
      // Safety net: if playback advanced past 0 while hovered, reveal the video
      // even should onStateChange have been missed.
      if (typeof t === 'number' && t > 0) setPlaying(true)

      // Mirror the player's REAL mute state into the icon (e.g. after a click-to-
      // unmute), so the speaker can never show "sound on" while actually silent.
      const m = p.isMuted?.()
      if (typeof m === 'boolean') setActualMuted(m)

      // Stall watchdog: if a muted preview somehow isn't playing for ~5s (a rare
      // network wedge), rebuild it once — a muted start always plays — so the
      // preview reliably ends up showing video.
      const isPlaying = p.getPlayerState?.() === 1
      if (isPlaying) {
        stallSinceRef.current = null
      } else if (playerReadyRef.current && !fallbackTriedRef.current) {
        const now = Date.now()
        if (stallSinceRef.current == null) {
          stallSinceRef.current = now
        } else if (now - stallSinceRef.current > 5000) {
          fallbackTriedRef.current = true
          stallSinceRef.current = null
          teardownPlayer()
          createPlayer(0)
        }
      }
    }, 250)
    return () => { clearInterval(id); stallSinceRef.current = null }
  }, [isHovered, teardownPlayer, createPlayer])

  // Don't keep an idle player alive. Once the cursor leaves, wait a short beat
  // (so a quick re-hover stays warm) then destroy the iframe entirely. This caps
  // memory — otherwise every hovered card leaves a live player behind — and is a
  // hard guarantee against audio leaking from a paused-but-still-loading embed
  // (display:none doesn't stop iframe sound; a destroyed iframe can't play).
  useEffect(() => {
    if (isHovered || !playerCreatedRef.current) return
    const id = window.setTimeout(teardownPlayer, PLAYER_IDLE_TEARDOWN_MS)
    return () => clearTimeout(id)
  }, [isHovered, teardownPlayer])

  // Destroy player on unmount; reset flags so StrictMode double-mount works cleanly
  useEffect(() => {
    return () => { teardownPlayer() }
  }, [teardownPlayer])

  // Keyboard shortcuts: m = mute, c = cc (only when this card is hovered)
  useEffect(() => {
    if (!isHovered) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const p = playerRef.current
      if (!p) return
      if (e.key === 'm') {
        // Toggle this card's mute. The keypress is a gesture, so unmuting is
        // allowed; applied to the player directly.
        if (displayMuted) {
          p.unMute()
          setActualMuted(false)
          if (volume === 0) { p.setVolume(100); setAudioVolume(100) }
        } else {
          p.mute(); setActualMuted(true)
        }
      } else if (e.key === 'c') {
        toggleCaptions()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isHovered, displayMuted, volume, showCaptions])

  // Fetch storyboard on first hover
  const fetchStoryboard = useCallback(async () => {
    if (storyboard) return
    try {
      const res = await fetch(`/api/feed/storyboard/${video.youtube_id}`)
      const data = await res.json()
      if (data?.fragment_urls?.length) setStoryboard(data)
    } catch { /* ignore */ }
  }, [video.youtube_id, storyboard])

  useEffect(() => {
    // Gate on localOnly, not localSrc: a download card has localSrc briefly undefined
    // while its blob loads, and we must NOT fetch the YouTube storyboard in that window
    // (it would show a second preview alongside the local scrubber).
    if (isHovered && !localOnly) fetchStoryboard()
  }, [isHovered, localOnly, fetchStoryboard])

  // Global drag listeners for progress scrubbing
  useEffect(() => {
    const onMove = (e: MouseEvent) => { if (isDraggingRef.current) seekFromXRef.current(e.clientX) }
    const onUp = () => { isDraggingRef.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  // Reset controls when preview closes. Volume (shared + persisted) and caption
  // on/off (remembered per video) are intentionally NOT reset here. Mute always
  // resets: every fresh hover starts muted (next hover re-derives from its player).
  useEffect(() => {
    if (!isHovered) {
      setCurrentTime(0)
      setHoverRatio(null)
      setPlaying(false)  // bring the thumbnail back until the next play starts
      setActualMuted(null)  // next hover starts muted again
      stallSinceRef.current = null
      fallbackTriedRef.current = false
      wantsUnmuteRef.current = false
    }
  }, [isHovered])

  // Close the "more actions" menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) { setMenuOpen(false); setShowSavePanel(false) }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  // Add the video to the offline Downloads library (server downloads it to disk).
  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDownload?.(video)
    setMenuOpen(false)
  }

  const handleRemoveDownload = (e: React.MouseEvent) => {
    e.stopPropagation()
    onRemoveDownload?.(video)
    setMenuOpen(false)
  }

  const handleHideChannel = (e: React.MouseEvent) => {
    e.stopPropagation()
    onHideChannel?.(video.channel_id)
    setMenuOpen(false)
  }

  const handleRemoveFromPlaylist = (e: React.MouseEvent) => {
    e.stopPropagation()
    onRemoveFromPlaylist?.(video)
    setMenuOpen(false)
  }

  const handleMuteToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    const p = playerRef.current
    // Toggle this card's mute. The click is a gesture, so unmuting is allowed.
    if (displayMuted) {
      p?.unMute()
      setActualMuted(false)
      // Unmuting while the slider sits at 0 would be silent — restore audible volume.
      if (volume === 0) { p?.setVolume(100); setAudioVolume(100) }
    } else {
      p?.mute(); setActualMuted(true)
    }
  }

  // Volume slider: persist the new volume (all previews follow via the store effect)
  // and keep this card's mute consistent — dragging up unmutes, dragging to 0 mutes.
  // Apply to this player directly too so the change is immediate during the drag.
  const handleVolumeChange = (v: number) => {
    const p = playerRef.current
    p?.setVolume(v)
    setAudioVolume(v)
    if (v === 0) { p?.mute(); setActualMuted(true) }
    else if (displayMuted) { p?.unMute(); setActualMuted(false) }
  }

  // Lazily fetch the transcript the first time captions are switched on, then
  // render it ourselves (see the caption overlay in the JSX). No player restart.
  // Sets captions to [] when the video has no track — that empties `activeCaption`
  // and drives the CC button's "unavailable" state (see captionsUnavailable).
  const fetchCaptions = useCallback(() => {
    if (captionsFetchedRef.current) return
    captionsFetchedRef.current = true
    fetch(`/api/feed/captions/${video.youtube_id}`)
      .then((r) => r.json())
      .then((d) => setCaptions(Array.isArray(d?.cues) ? d.cues : []))
      .catch(() => setCaptions([]))
  }, [video.youtube_id])

  // null = not fetched yet; [] = fetched, this video has no captions.
  const captionsUnavailable = captions !== null && captions.length === 0

  const toggleCaptions = () => {
    if (captionsUnavailable) return  // nothing to toggle
    const next = !showCaptions
    setShowCaptions(next)
    ccPrefByVideo.set(video.youtube_id, next)  // remember for re-hover this session
  }

  // Always fetch on hover — even when captions are toggled off — so we know whether
  // a track exists and can reflect that on the CC button. (Skipped for local files:
  // the transcript is a YouTube-only network fetch, and CC is hidden offline.)
  useEffect(() => {
    if (isHovered && !localOnly) fetchCaptions()
  }, [isHovered, localOnly, fetchCaptions])

  const handleCCToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    toggleCaptions()
  }

  // The caption line to show at the current playback time. Auto-generated cues
  // overlap (rolling window), so among all cues active at `currentTime` we take
  // the one that started most recently — that's the line being "spoken" now.
  const activeCaption = useMemo(() => {
    if (!showCaptions || !captions) return ''
    let best: Cue | null = null
    for (const c of captions) {
      if (c.start <= currentTime && currentTime < c.start + c.dur) {
        if (!best || c.start > best.start) best = c
      }
    }
    return best?.text ?? ''
  }, [showCaptions, captions, currentTime])

  const handleProgressMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    isDraggingRef.current = true
    seekFromX(e.clientX)
  }

  const handleProgressMouseMove = (e: React.MouseEvent) => {
    if (!progressBarRef.current) return
    const rect = progressBarRef.current.getBoundingClientRect()
    setHoverRatio(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
  }

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0
  const hoverTime = hoverRatio !== null ? hoverRatio * duration : null
  const sbFrame = storyboard && hoverTime !== null ? getStoryboardFrame(storyboard, hoverTime) : null

  // Local file: generate the scrubbing thumbnail from the video itself by seeking a
  // hidden <video> to the hovered time (offline — no YouTube storyboard needed).
  useEffect(() => {
    if (localSrc && scrubVideoRef.current && hoverTime !== null) {
      scrubVideoRef.current.currentTime = hoverTime
    }
  }, [hoverTime, localSrc])

  // Opening the video navigates away (new tab / modal / watch page). DESTROY the
  // preview player now rather than pausing it and letting the idle timer clean up
  // ~600ms later: the watch page immediately creates its own player for the SAME
  // video, and two live players for one video wedge the new one on a buffering
  // spinner (unmuted but silent). Worst when the preview was already playing with
  // sound. Tearing down first leaves the watch player alone with the video.
  const openVideo = () => {
    teardownPlayer()
    onHover(null)
    if (onOpen) { onOpen(video); return }
    // Navigate to the in-app watch page. Dispatched as an app-level event rather
    // than threaded as a callback through every feed surface (VideoRow / Channel /
    // Search / Playlist). cmd/middle-click still opens YouTube natively via the
    // card's real anchor; this only handles the plain-click "open" path.
    window.dispatchEvent(new CustomEvent<VideoItem>('app:watch', { detail: video }))
  }

  // Left-click on the video preview itself. First click on a muted, playing
  // preview UNMUTES it — the click is the gesture the autoplay policy requires,
  // so unmuting an already-playing muted video is reliable (no wedge, no spinner).
  // Once unmuted, a further click opens the video (the original behaviour). Only
  // the video area routes here; buttons / progress bar / title / menu all stop
  // propagation and keep their own behaviour, so they never unmute or open.
  const handleVideoActivate = () => {
    const p = playerRef.current
    if (isHoveredRef.current && displayMuted) {
      if (p && playerReadyRef.current) {
        p.unMute()
        setActualMuted(false)
        if (volume === 0) { p.setVolume(100); setAudioVolume(100) }
        return
      }
      // Clicked before the preview finished loading. Arm the unmute so it applies
      // the moment playback starts, instead of skipping straight to the watch page
      // — that keeps "first click = sound" consistent however fast you click.
      // Only the FIRST such click arms it; click again and you get the watch page,
      // so a slow-loading preview can never trap you.
      if (!wantsUnmuteRef.current) {
        wantsUnmuteRef.current = true
        return
      }
    }
    openVideo()
  }

  return (
    // isolate: contain the card's internal z-layers (anchor z-10, hover controls
    // z-30/z-40) in their own stacking context. Without it they leak into the page
    // root and paint over the sticky filter bar / topbar, so pointer events pass
    // through those bars to the card underneath.
    // While the ⋮ menu is open, lift the whole card above its siblings (z-[5]) so
    // the dropdown, which overflows the card's bottom, isn't covered by the card
    // below. Stays under the sticky filter bar (z-10) / topbar (z-20).
    <div className={`relative cursor-pointer isolate ${menuOpen ? 'z-[5]' : ''}`} onClick={handleVideoActivate}>
      {/* Thumbnail — hover here only triggers preview. Shorts are portrait (9:16). */}
      <div
        className={`relative rounded-xl overflow-hidden bg-[#272727] ${isShort ? 'aspect-[9/16]' : 'aspect-video'}`}
        onMouseEnter={() => onHover(video.youtube_id)}
        onMouseLeave={() => onHover(null)}
      >
        {/* Real anchor over the preview so right-click / middle-click / cmd-click get
           the native "Open link in new tab" behaviour. Sits below the control buttons
           (z-30+). Downloads open a local modal instead, so skip the YouTube link there. */}
        {!onOpen && (
          <a
            href={videoUrl}
            aria-label={video.title}
            className="absolute inset-0 z-10"
            onClick={(e) => {
              // Let modifier-clicks open in a new tab natively (real anchor).
              if (e.metaKey || e.ctrlKey || e.shiftKey) return
              e.preventDefault(); e.stopPropagation()
              handleVideoActivate()
            }}
          />
        )}

        {/* Static thumbnail — fills the card (object-cover crops the 16:9 source to
           the portrait frame for Shorts, and fills exactly for landscape). Stays
           on top (z-[5], above the player) until playback starts, so the ~1-2s
           embed load shows the thumbnail instead of a blank card. */}
        <div className="absolute inset-0 z-[5]" style={{ display: playing ? 'none' : 'block' }}>
          <img
            src={thumb}
            alt={video.title}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={() => {
              // Candidate 404'd (e.g. no maxresdefault) — try the next one.
              if (isShort) setShortThumbIdx((i) => Math.min(i + 1, shortThumbs.length - 1))
            }}
            onLoad={(e) => {
              // Loaded, but it's YouTube's 120×90 grey "no thumbnail" placeholder
              // (a valid 200, so onError never fires) — advance to the next candidate.
              if (isShort && e.currentTarget.naturalWidth <= 120 && shortThumbIdx < shortThumbs.length - 1) {
                setShortThumbIdx((i) => i + 1)
              }
            }}
          />
          {/* While the thumbnail holds and the embed loads (hovered, not yet
             playing), fade the thumbnail toward black over ~1.5s. ease-in keeps a
             quick/warm hover barely dimmed, while a prolonged wait goes fully
             black as a "still loading" cue. Removed once playback starts. */}
          {isHovered && !playing && (
            <div className="absolute inset-0 bg-black pointer-events-none preview-dim" />
          )}
        </div>

        {/* Video player */}
        <div
          className="absolute inset-0 overflow-hidden"
          style={{ display: isHovered ? 'block' : 'none' }}
        >
          {/* React owns nothing inside here — YT.Player appends its iframe imperatively.
             Symmetric vertical over-scan: the iframe is 64px taller than the card on
             BOTH top and bottom. YouTube anchors its chrome (top share/watch-later bar,
             bottom logo) to the iframe edges, so those edges are pushed outside the
             overflow:hidden card and clipped, while the 16:9 video stays fit-to-width and
             centered, filling the card exactly. We render captions ourselves (below), so
             clipping the video's own caption strip no longer matters. */}
          <div
            ref={playerWrapperRef}
            className="absolute"
            style={localSrc
              ? { top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }  // native <video>: no chrome, no crop
              : isShort
                // Vertical short: the 16:9 embed pillarboxes the 9:16 video. Match the
                // iframe HEIGHT to the 9:16 card and over-scan the WIDTH (316% ≈ (16/9)²)
                // centered, so the centered video strip fills the card exactly and the
                // black side bars fall outside the overflow-hidden frame — no cropping.
                ? { top: 0, left: '50%', width: '316%', height: '100%', transform: 'translateX(-50%)', pointerEvents: 'none' }
                // Landscape: symmetric vertical over-scan clips YouTube's top/bottom chrome.
                : { top: '-64px', left: 0, width: '100%', height: 'calc(100% + 128px)', pointerEvents: 'none' }}
          />
          <div className="absolute inset-0" style={{ zIndex: 2 }} />

          {/* Our own caption overlay — rendered from the fetched transcript so we
             fully control size/position/style (YouTube's embed captions are tiny).
             Sits above the progress bar (which lifts up on hover) so they never overlap. */}
          {showCaptions && activeCaption && (
            <div className="absolute inset-x-0 bottom-7 z-20 flex justify-center px-3 pointer-events-none">
              <span className="max-w-[95%] text-center text-white text-sm md:text-base font-medium leading-snug bg-black/70 rounded px-2 py-0.5 [text-wrap:balance]">
                {activeCaption}
              </span>
            </div>
          )}
        </div>

        {/* Right-side controls — bookmark → mute → CC, equal gaps. items-end keeps
           them right-aligned so the volume slider can expand leftward without
           shifting the circular buttons. */}
        <div className="absolute top-1 right-1 z-30 flex flex-col gap-1 items-end">
          {onToggleWatchLater && (isHovered || isWatchLater) && (
            <button
              className={isWatchLater ? BTN_LIGHT : BTN_DARK}
              onClick={(e) => { e.stopPropagation(); onToggleWatchLater(video) }}
              title={isWatchLater ? 'Remove from Watch Later' : 'Save to Watch Later'}
            >
              {isWatchLater ? (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
                </svg>
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
                </svg>
              )}
            </button>
          )}

          {isHovered && (
            // Mute button + volume slider as one pill. The slider is collapsed to
            // zero width and slides out to the LEFT of the speaker on hover (the
            // speaker stays put on the right so the controls column stays aligned).
            <div className="group/vol flex items-center rounded-full bg-black/60" onClick={(e) => e.stopPropagation()}>
              {/* overflow-hidden drives the horizontal collapse animation but also
                 clips the round thumb, which overflows the 4px track. py-2.5 gives it
                 vertical room; the horizontal px-3 is applied ONLY when expanded — with
                 box-border, keeping px-3 while collapsed leaves a 24px stub that makes
                 the resting mute button an oval instead of a clean circle. */}
              <div className="flex items-center overflow-hidden max-w-0 opacity-0 py-2.5 transition-all duration-200 ease-out group-hover/vol:max-w-[128px] group-hover/vol:px-3 group-hover/vol:opacity-100">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={displayMuted ? 0 : volume}
                  onChange={(e) => handleVolumeChange(Number(e.target.value))}
                  onMouseDown={(e) => e.stopPropagation()}
                  aria-label="Volume"
                  className="vol-slider w-20"
                  style={{ background: `linear-gradient(to right, #fff ${displayMuted ? 0 : volume}%, rgba(255,255,255,0.18) ${displayMuted ? 0 : volume}%)` }}
                />
              </div>
              <button className="p-2 rounded-full text-white hover:bg-white/15 transition-colors" onClick={handleMuteToggle} title={displayMuted ? 'Unmute' : 'Mute'}>
                {displayMuted ? (
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                  </svg>
                ) : (
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                  </svg>
                )}
              </button>
            </div>
          )}

          {isHovered && !localSrc && !localOnly && (
            <button
              className={
                captionsUnavailable
                  // Same dark circle, but NO hover:bg change — it isn't clickable,
                  // so it shouldn't give clickable hover feedback.
                  ? `${BTN} bg-black/60 text-white`
                  : showCaptions ? BTN_LIGHT : BTN_DARK
              }
              onClick={handleCCToggle}
              title={
                captionsUnavailable
                  ? 'No captions available'
                  : showCaptions ? 'Hide captions' : 'Show captions'
              }
            >
              {/* When no caption track exists: keep the dark circle visible but gray
                 the CC text and strike it through so the disabled state reads on any
                 background (dark video frames made a faded whole-button invisible). */}
              <span className={`relative w-5 h-5 flex items-center justify-center text-[11px] font-bold leading-none ${captionsUnavailable ? 'text-white/40' : ''}`}>
                CC
                {captionsUnavailable && (
                  <span className="absolute left-[-2px] right-[-2px] top-1/2 h-px bg-current -rotate-45" />
                )}
              </span>
            </button>
          )}
        </div>

        {/* Progress bar + storyboard preview. z-40 (above the z-30 right-side buttons)
           so the scrub/storyboard thumbnail floats over them near the top of the card. */}
        {isHovered && (
          <div
            className="absolute bottom-0 left-0 right-0 z-40 px-2 pb-2 pt-6 bg-gradient-to-t from-black/70 to-transparent group/controls"
            onClick={(e) => e.stopPropagation()}
            onMouseMove={(e) => {
              if (!progressBarRef.current) return
              const rect = progressBarRef.current.getBoundingClientRect()
              setHoverRatio(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
            }}
            onMouseDown={(e) => {
              if (!progressBarRef.current) return
              e.stopPropagation()
              e.preventDefault()
              isDraggingRef.current = true
              seekFromX(e.clientX)
            }}
            onMouseLeave={() => setHoverRatio(null)}
          >
            {/* Bar wrapper — lifts up when cursor enters the controls area */}
            <div className="transition-transform duration-150 group-hover/controls:-translate-y-2">
              <div
                ref={progressBarRef}
                className="relative py-2 -my-2 cursor-pointer group/bar"
                onMouseDown={handleProgressMouseDown}
                onMouseMove={handleProgressMouseMove}
              >
                {/* Storyboard preview (YouTube) — floats above the hit area */}
                {sbFrame && hoverRatio !== null && (
                  <div
                    className="absolute pointer-events-none"
                    style={{
                      bottom: '20px',
                      left: `clamp(${sbFrame.fw / 2}px, ${(hoverRatio * 100).toFixed(2)}%, calc(100% - ${sbFrame.fw / 2}px))`,
                      transform: 'translateX(-50%)',
                    }}
                  >
                    <div
                      className="rounded overflow-hidden shadow-lg border border-white/20"
                      style={{
                        width: sbFrame.fw,
                        height: sbFrame.fh,
                        backgroundImage: `url(${sbFrame.url})`,
                        backgroundPosition: `${sbFrame.bgX}px ${sbFrame.bgY}px`,
                        backgroundRepeat: 'no-repeat',
                        backgroundSize: `${sbFrame.sheetW}px ${sbFrame.sheetH}px`,
                      }}
                    />
                    <div className="text-center mt-1">
                      <span className="inline-block bg-black/80 text-white text-sm font-semibold px-1.5 py-0.5 rounded">
                        {formatDuration(Math.round(hoverTime!))}
                      </span>
                    </div>
                  </div>
                )}

                {/* Scrubbing preview (local file) — a hidden <video> seeked to the
                   hovered time. Kept mounted while hovered so the frame is instant;
                   only shown/positioned once the cursor is over the progress bar. */}
                {localSrc && isHovered && (
                  <div
                    className="absolute pointer-events-none transition-opacity duration-75"
                    style={{
                      bottom: '20px',
                      // Fixed width so the popup keeps its size when clamped near the edge
                      // (an auto-width abs box would shrink-to-fit the remaining space).
                      width: 160,
                      left: hoverRatio !== null ? `clamp(80px, ${(hoverRatio * 100).toFixed(2)}%, calc(100% - 80px))` : '50%',
                      transform: 'translateX(-50%)',
                      opacity: hoverRatio !== null ? 1 : 0,
                    }}
                  >
                    <video
                      ref={scrubVideoRef}
                      src={localSrc}
                      muted
                      preload="auto"
                      className="rounded shadow-lg border border-white/20 bg-black object-cover"
                      style={{ width: 160, height: 90, maxWidth: 'none' }}
                    />
                    <div className="text-center mt-1">
                      {hoverTime !== null && (
                        <span className="inline-block bg-black/80 text-white text-sm font-semibold px-1.5 py-0.5 rounded">
                          {formatDuration(Math.round(hoverTime))}
                        </span>
                      )}
                    </div>
                  </div>
                )}

              <div
                className="relative h-1 bg-white/30 rounded-full"
              >
                {/* Playback fill */}
                <div className="absolute inset-y-0 left-0 bg-red-500 rounded-full" style={{ width: `${progress * 100}%` }} />

                {/* Hover position indicator */}
                {hoverRatio !== null && (
                  <div
                    className="absolute top-1/2 w-0.5 h-3 bg-white/50 -translate-y-1/2 pointer-events-none"
                    style={{ left: `${hoverRatio * 100}%` }}
                  />
                )}

                {/* Scrubber handle */}
                <div
                  className="absolute top-1/2 w-3 h-3 bg-red-500 rounded-full shadow -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover/controls:opacity-100 transition-opacity pointer-events-none"
                  style={{ left: `${progress * 100}%` }}
                />
              </div>
              </div>
            </div>
          </div>
        )}

        {/* Duration badge — shows remaining time while hovered, hides when preview scrubbing */}
        {video.duration_seconds > 0 && !hoverRatio && (
          <div className={`absolute right-1 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded font-medium transition-all ${isHovered ? 'bottom-6' : 'bottom-1'}`}>
            {isHovered && duration > 0
              ? formatDuration(Math.max(0, Math.round(duration - currentTime)))
              : formatDuration(video.duration_seconds)}
          </div>
        )}
      </div>

      {/* Info row */}
      <div className="flex gap-3 mt-2">
        <div className="flex-1 min-w-0">
          {onOpen ? (
            <h3 className="text-sm font-medium text-white line-clamp-2 leading-5">{video.title}</h3>
          ) : (
            <a
              href={videoUrl}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); openVideo() }}
              className="block text-sm font-medium text-white line-clamp-2 leading-5"
            >
              {video.title}
            </a>
          )}
          {/* Channel — a real link to the channel page (right-click → open in new tab) */}
          <a
            href={`/channel/${video.channel_id}`}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChannelClick(video.channel_id) }}
            className="inline-block text-xs text-[#aaaaaa] mt-0.5 hover:text-blue-400 transition-colors"
          >
            {video.channel_name || 'Unknown'}
          </a>
          <p className="text-xs text-[#717171] mt-0.5">
            {(() => {
              const likeRate = video.view_count > 0 ? (video.like_count / video.view_count) * 100 : null
              const stats: { key: string; label: string }[] = [
                { key: 'views', label: formatViewCount(video.view_count) + ' views' },
                { key: 'score', label: video.score.toFixed(1) + ' v/h' },
                { key: 'likes', label: formatViewCount(video.like_count) + ' likes' },
                ...(likeRate !== null ? [{ key: 'like%', label: likeRate.toFixed(1) + '%' }] : []),
                { key: 'newest', label: timeAgo(video.published_at) },
              ]
              return stats.map(({ key, label }, i) => {
                const active = sort === key || (key === 'newest' && sort === 'oldest')
                return (
                  <span key={key}>
                    {i > 0 && <span className="text-[#444]"> · </span>}
                    <span className={active ? 'text-white font-medium' : ''}>{label}</span>
                  </span>
                )
              })
            })()}
          </p>
        </div>

        {/* More-actions menu (right of the title). self-start so this container
           hugs the button height — otherwise the flex row stretches it to the
           full info-row height and the top-full dropdown drops below the card. */}
        <div className="relative flex-shrink-0 self-start" ref={menuRef}>
          <button
            className="p-1.5 -mr-1 rounded-full text-[#aaa] hover:bg-white/10 hover:text-white transition-colors"
            onClick={(e) => { e.stopPropagation(); setShowSavePanel(false); setMenuOpen((o) => !o) }}
            title="More actions"
            aria-label="More actions"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
            </svg>
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-full mt-1 z-40 min-w-[180px] rounded-xl bg-[#282828] shadow-2xl ring-1 ring-white/10 py-2"
              onClick={(e) => e.stopPropagation()}
            >
              {showSavePanel ? (
                <SaveToPlaylist video={video} onBack={() => setShowSavePanel(false)} />
              ) : (
              <>
              <button
                className="w-full flex items-center gap-4 px-4 py-2.5 text-sm text-white hover:bg-white/10 transition-colors"
                onClick={(e) => { e.stopPropagation(); setShowSavePanel(true) }}
              >
                <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
                </svg>
                Save to playlist
              </button>
              {onRemoveFromPlaylist && (
                <button
                  className="w-full flex items-center gap-4 px-4 py-2.5 text-sm text-white hover:bg-white/10 transition-colors"
                  onClick={handleRemoveFromPlaylist}
                >
                  <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h11M4 12h11M4 18h7M15 15l6 6m0-6l-6 6" />
                  </svg>
                  Remove from playlist
                </button>
              )}
              {onRemoveDownload ? (
                <button
                  className="w-full flex items-center gap-4 px-4 py-2.5 text-sm text-white hover:bg-white/10 transition-colors"
                  onClick={handleRemoveDownload}
                >
                  <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0v12a1 1 0 001 1h6a1 1 0 001-1V7"/>
                  </svg>
                  Remove download
                </button>
              ) : (
                <button
                  className="w-full flex items-center gap-4 px-4 py-2.5 text-sm text-white hover:bg-white/10 transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
                  onClick={handleDownload}
                  disabled={isDownloaded}
                >
                  {isDownloaded ? (
                    <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
                    </svg>
                  ) : (
                    <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>
                    </svg>
                  )}
                  {isDownloaded ? 'Downloaded' : 'Download'}
                </button>
              )}
              {onHideChannel && (
                <button
                  className="w-full flex items-center gap-4 px-4 py-2.5 text-sm text-white hover:bg-white/10 transition-colors"
                  onClick={handleHideChannel}
                >
                  <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.542-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.542 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>
                  </svg>
                  Hide channel
                </button>
              )}
              </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
