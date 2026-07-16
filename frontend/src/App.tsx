import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import VideoRow from './components/VideoRow'
import ChannelsPage from './components/ChannelsPage'
import ChannelPage from './components/ChannelPage'
import DownloadsPage from './components/DownloadsPage'
import SearchPage from './components/SearchPage'
import { preloadYouTubeApi } from './components/VideoCard'
import PlaylistsPage from './components/PlaylistsPage'
import type { PlaylistSummary } from './components/PlaylistsPage'
import PlaylistPage from './components/PlaylistPage'
import WatchPage from './components/WatchPage'

export type DownloadItem = {
  youtube_id: string
  title: string
  channel_id: string
  channel_name: string
  thumbnail_url: string
  duration_seconds: number
  published_at: string
  view_count: number
  like_count: number
  score: number
  status: 'downloading' | 'ready' | 'error'
  error: string
  filesize: number
  created_at: string | null
}

export type VideoItem = {
  youtube_id: string
  title: string
  channel_id: string
  channel_name?: string
  channel_thumbnail?: string
  thumbnail_url: string
  published_at: string
  view_count: number
  like_count: number
  duration_seconds: number
  is_short?: boolean
  score: number
}

export type TagInfo = {
  name: string
  group: string
  icon: string
  channel_count: number
}

export type FeedGroup = {
  name: string
  icon: string
  sort_order: number
  videos: VideoItem[]
}

export type FeedResponse = {
  categories: { name: string; icon: string; sort_order: number }[]
  groups: FeedGroup[]
  window: string
}

// ── URL helpers ─────────────────────────────────────────────

// NB: there's no 'watch' page — /watch/:id is a full-screen overlay rendered on
// top of whichever page you were on (see selectedVideoId), so that page stays
// mounted underneath with its scroll and loaded videos intact.
type Page = 'feed' | 'channels' | 'channel' | 'watchlater' | 'downloads' | 'search' | 'playlists' | 'playlist'

function parsePath(): { page: Page; channelId: string | null; playlistId: number | null; videoId: string | null } {
  const path = window.location.pathname
  const base = { channelId: null, playlistId: null, videoId: null }
  if (path === '/channels') return { page: 'channels', ...base }
  if (path === '/watchlater') return { page: 'watchlater', ...base }
  if (path === '/downloads') return { page: 'downloads', ...base }
  if (path === '/search') return { page: 'search', ...base }
  if (path === '/playlists') return { page: 'playlists', ...base }
  // /watch/:id is a full-screen OVERLAY, not a page — the underlying page stays
  // mounted behind it. `page` is the underlying page (feed by default on a cold
  // load); `videoId` drives the overlay.
  const wm = path.match(/^\/watch\/([^/]+)/)
  if (wm) return { page: 'feed', ...base, videoId: wm[1] }
  const pm = path.match(/^\/playlist\/(\d+)/)
  if (pm) return { page: 'playlist', ...base, playlistId: Number(pm[1]) }
  const m = path.match(/^\/channel\/([^/]+)/)
  if (m) return { page: 'channel', ...base, channelId: m[1] }
  return { page: 'feed', ...base }
}

function parseSearch(): { tags: string[]; window: string; sort: string; timeMode: string; channelsSort: string; shorts: boolean } {
  const p = new URLSearchParams(window.location.search)
  const rawSort = p.get('sort')
  return {
    tags: p.get('tags') ? p.get('tags')!.split(',').filter(Boolean) : [],
    window: p.get('window') || '3d',
    sort: rawSort || 'likes',
    timeMode: p.get('time_mode') || 'wide',
    channelsSort: rawSort || 'subs',
    shorts: p.get('shorts') === '1',
  }
}

export function buildPath(
  page: string,
  channelId: string | null,
  tags: string[],
  window: string,
  sort: string,
  timeMode: string,
  channelsSort: string,
  shorts = false,
): string {
  const params = new URLSearchParams()
  if (tags.length > 0) params.set('tags', tags.join(','))
  if (window !== '3d') params.set('window', window)
  if (page === 'channels') {
    if (channelsSort !== 'subs') params.set('sort', channelsSort)
  } else {
    if (sort !== 'likes') params.set('sort', sort)
  }
  if (timeMode !== 'wide') params.set('time_mode', timeMode)
  // Shorts vs long-form is only meaningful on the feed and a channel page.
  if (shorts && (page === 'feed' || page === 'channel')) params.set('shorts', '1')
  const qs = params.toString()

  if (page === 'channels') return qs ? `/channels?${qs}` : '/channels'
  if (page === 'watchlater') return '/watchlater'
  if (page === 'downloads') return '/downloads'
  if (page === 'search') return '/search'  // ?q= is appended by the search URL sync
  if (page === 'playlists') return '/playlists'
  // 'playlist' (single) is navigated directly with its id; syncUrl skips it
  if (page === 'channel' && channelId) {
    return qs ? `/channel/${channelId}?${qs}` : `/channel/${channelId}`
  }
  // feed
  return qs ? `/?${qs}` : '/'
}

// ── Watch Later helpers ──────────────────────────────────────

const WINDOW_HOURS: Record<string, number> = {
  '1d': 24, '3d': 72, '1w': 168, '2w': 336,
  '1m': 720, '3m': 2160, '6m': 4320, '1y': 8760,
}

export function filterWatchLater(videos: VideoItem[], win: string, timeMode: string): VideoItem[] {
  const hours = WINDOW_HOURS[win]
  if (!hours) return videos
  const now = Date.now()
  const cutoff = now - hours * 3_600_000
  if (timeMode === 'wide') return videos.filter(v => new Date(v.published_at).getTime() >= cutoff)
  return videos.filter(v => {
    const t = new Date(v.published_at).getTime()
    return t >= cutoff && t <= now
  })
}

export function sortWatchLater(videos: VideoItem[], sort: string): VideoItem[] {
  const v = [...videos]
  if (sort === 'views') return v.sort((a, b) => b.view_count - a.view_count)
  if (sort === 'score') return v.sort((a, b) => b.score - a.score)
  if (sort === 'likes') return v.sort((a, b) => b.like_count - a.like_count)
  if (sort === 'like%') return v.sort((a, b) => {
    const ra = a.view_count > 0 ? a.like_count / a.view_count : 0
    const rb = b.view_count > 0 ? b.like_count / b.view_count : 0
    return rb - ra
  })
  if (sort === 'oldest') return v.sort((a, b) => new Date(a.published_at).getTime() - new Date(b.published_at).getTime())
  if (sort === 'newest') return v.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())
  return v
}

// ── App ─────────────────────────────────────────────────────

const ACTIVE_INTERVAL = 5 * 60 * 1000  // 5 min when visible
const INACTIVE_INTERVAL = 15 * 60 * 1000  // 15 min when hidden

const FEED_PAGE_SIZE = 60  // home-feed pagination: videos fetched per page

export default function App() {
  // Init from URL
  const initPath = parsePath()
  const initQ = parseSearch()
  const [page, setPageRaw] = useState<Page>(initPath.page)
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | null>(initPath.playlistId)
  // In-app watch page: the video id from the URL, plus the VideoItem we arrived
  // with (null on cold load / back-forward, where WatchPage fetches by id).
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(initPath.videoId)
  const [selectedVideo, setSelectedVideo] = useState<VideoItem | null>(null)
  // Whether the watch overlay is currently open — lets popstate tell "closing
  // the overlay" (leave the underlying page untouched) from a real page nav.
  const overlayOpenRef = useRef<boolean>(!!initPath.videoId)
  const [searchInput, setSearchInput] = useState<string>(() => new URLSearchParams(window.location.search).get('q') || '')
  // True once we've pushed a /search history entry, so clearing the box can go
  // back() to the page (and its state) we were on before searching.
  const searchPushedRef = useRef(false)
  const [feed, setFeed] = useState<FeedResponse | null>(null)
  const [feedTotal, setFeedTotal] = useState(0)          // total ranked videos in the window
  const feedLoadedRef = useRef(0)                          // videos currently loaded (for bg refresh)
  const feedLoadingMoreRef = useRef(false)                 // guard against overlapping page fetches
  const [tags, setTags] = useState<TagInfo[]>([])
  const [selectedTags, setSelectedTags] = useState<string[]>(initQ.tags)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(initPath.channelId)
  const [loading, setLoading] = useState(true)
  const [timeWindow, setTimeWindow] = useState(initQ.window)
  const [sort, setSort] = useState(initQ.sort)
  const [timeMode, setTimeMode] = useState(initQ.timeMode)
  const [channelsSort, setChannelsSort] = useState(initQ.channelsSort)
  // Videos ↔ Shorts: switches the feed / channel pages between long-form and
  // vertical short-form. Shorts live on a separate channel tab and rank very
  // differently, so they're a distinct browse mode rather than mixed in.
  // Persisted in the URL (?shorts=1) so a reload/shared link lands on the same mode.
  const [contentMode, setContentMode] = useState<'videos' | 'shorts'>(initQ.shorts ? 'shorts' : 'videos')

  // ── Watch Later ───────────────────────────────────────
  const [watchLater, setWatchLater] = useState<VideoItem[]>([])
  const watchLaterIds = useMemo(() => new Set(watchLater.map(v => v.youtube_id)), [watchLater])

  const fetchWatchLater = useCallback(async () => {
    try {
      const res = await fetch('/api/watch-later')
      if (res.ok) setWatchLater(await res.json())
    } catch { /* ignore */ }
  }, [])

  // Load from the backend on mount, migrating any legacy localStorage entries once.
  useEffect(() => {
    (async () => {
      try {
        const legacy = JSON.parse(localStorage.getItem('watch_later') || '[]')
        if (Array.isArray(legacy) && legacy.length > 0) {
          await Promise.all(legacy.map((v: VideoItem) =>
            fetch('/api/watch-later', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(v),
            }).catch(() => {})))
          localStorage.removeItem('watch_later')
        }
      } catch { /* ignore */ }
      fetchWatchLater()
    })()
  }, [fetchWatchLater])

  function toggleWatchLater(video: VideoItem) {
    const has = watchLater.some(v => v.youtube_id === video.youtube_id)
    // optimistic update, then sync to the backend
    setWatchLater(prev => has ? prev.filter(v => v.youtube_id !== video.youtube_id) : [video, ...prev])
    if (has) {
      fetch(`/api/watch-later/${video.youtube_id}`, { method: 'DELETE' }).catch(() => {})
    } else {
      fetch('/api/watch-later', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(video),
      }).catch(() => {})
    }
  }

  // ── Hidden channels (excluded from the home feed) ─────
  // Server-side now (syncs across devices); the feed query already excludes them.
  const [hiddenChannels, setHiddenChannels] = useState<Set<string>>(new Set())
  // When on, hidden channels' videos are shown in the feed anyway (a temporary peek).
  const [showHidden, setShowHidden] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // One-time migration of the old browser-local hidden list, then forget it.
      try {
        const legacy = localStorage.getItem('hidden_channels')
        if (legacy !== null) {
          const ids: string[] = JSON.parse(legacy) || []
          if (ids.length > 0) {
            await fetch('/api/hidden-channels/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ channel_ids: ids }),
            })
          }
          localStorage.removeItem('hidden_channels')
        }
      } catch { /* ignore malformed legacy data */ }
      try {
        const res = await fetch('/api/hidden-channels')
        const data = await res.json()
        if (!cancelled) setHiddenChannels(new Set<string>(data.channel_ids ?? []))
      } catch { /* leave empty on failure */ }
    })()
    return () => { cancelled = true }
  }, [])

  // From the video-card menu: hide the channel from the home feed (optimistic).
  function hideChannel(channelId: string) {
    if (hiddenChannels.has(channelId)) return
    setHiddenChannels(prev => { const next = new Set(prev); next.add(channelId); return next })
    fetch(`/api/hidden-channels/${channelId}`, { method: 'POST' }).catch(() => {})
  }
  // From the Channels page: flip a channel's hidden state (optimistic).
  function toggleHiddenChannel(channelId: string) {
    const wasHidden = hiddenChannels.has(channelId)
    setHiddenChannels(prev => {
      const next = new Set(prev)
      wasHidden ? next.delete(channelId) : next.add(channelId)
      return next
    })
    fetch(`/api/hidden-channels/${channelId}`, { method: wasHidden ? 'DELETE' : 'POST' }).catch(() => {})
  }

  // ── Playlists (server-side) ───────────────────────────
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([])
  const fetchPlaylists = useCallback(async () => {
    try {
      const res = await fetch('/api/playlists')
      if (res.ok) setPlaylists(await res.json())
    } catch { /* ignore */ }
  }, [])
  useEffect(() => { fetchPlaylists() }, [fetchPlaylists])
  // A video card's save-to-playlist panel fires this when it changes anything.
  useEffect(() => {
    const h = () => fetchPlaylists()
    window.addEventListener('playlists-changed', h)
    return () => window.removeEventListener('playlists-changed', h)
  }, [fetchPlaylists])

  const deletePlaylist = useCallback(async (id: number) => {
    setPlaylists(prev => prev.filter(p => p.id !== id))
    try { await fetch(`/api/playlists/${id}`, { method: 'DELETE' }) } catch { /* ignore */ }
    fetchPlaylists()
  }, [fetchPlaylists])

  // ── Downloads (server-side offline library) ───────────
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const downloadIds = useMemo(() => new Set(downloads.map(d => d.youtube_id)), [downloads])

  const fetchDownloads = useCallback(async () => {
    try {
      const res = await fetch('/api/downloads')
      if (res.ok) setDownloads(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { fetchDownloads() }, [fetchDownloads])

  // Poll while anything is still downloading so the library updates to "ready".
  useEffect(() => {
    if (!downloads.some(d => d.status === 'downloading')) return
    const id = setInterval(fetchDownloads, 2000)
    return () => clearInterval(id)
  }, [downloads, fetchDownloads])

  const startDownload = useCallback(async (video: {
    youtube_id: string; title: string; channel_id: string
    channel_name?: string; thumbnail_url: string; duration_seconds: number
    published_at?: string; view_count?: number; like_count?: number; score?: number
  }) => {
    const meta = {
      youtube_id: video.youtube_id, title: video.title, channel_id: video.channel_id,
      channel_name: video.channel_name || '', thumbnail_url: video.thumbnail_url,
      duration_seconds: video.duration_seconds, published_at: video.published_at || '',
      view_count: video.view_count || 0, like_count: video.like_count || 0, score: video.score || 0,
    }
    // optimistic: show it immediately as downloading
    setDownloads(prev => prev.some(d => d.youtube_id === video.youtube_id) ? prev
      : [{ ...meta, status: 'downloading', error: '', filesize: 0, created_at: new Date().toISOString() }, ...prev])
    try {
      await fetch('/api/downloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      })
    } catch { /* ignore */ }
    fetchDownloads()
  }, [fetchDownloads])

  const deleteDownload = useCallback(async (videoId: string) => {
    setDownloads(prev => prev.filter(d => d.youtube_id !== videoId))
    try { await fetch(`/api/downloads/${videoId}`, { method: 'DELETE' }) } catch { /* ignore */ }
  }, [])

  // ── YouTube API token health (reminder to re-auth) ────
  const [tokenBad, setTokenBad] = useState(false)
  const [tokenNoticeDismissed, setTokenNoticeDismissed] = useState(
    () => sessionStorage.getItem('yt_token_notice_dismissed') === '1'
  )
  const checkToken = useCallback((force = false) => {
    fetch(`/api/youtube-token${force ? '?force=1' : ''}`)
      .then(r => r.json())
      .then(d => setTokenBad(d && d.ok === false))
      .catch(() => {})
  }, [])
  useEffect(() => {
    checkToken()
    // Re-check when returning to the tab — clears the banner right after re-auth.
    const onFocus = () => checkToken(true)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkToken])

  // ── Sidebar state ─────────────────────────────────────
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const topbarRef = useRef<HTMLDivElement>(null)

  // ── Mobile detection ──────────────────────────────────
  const [isMobile, setIsMobile] = useState(() => matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const mq = matchMedia('(max-width: 767px)')
    const handler = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches)
      if (!e.matches) setTopbarPinned(true)
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Measure topbar height so <main> can pad below it when fixed on mobile.
  const [topbarHeight, setTopbarHeight] = useState(0)
  useEffect(() => {
    const el = topbarRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setTopbarHeight(el.offsetHeight))
    ro.observe(el)
    setTopbarHeight(el.offsetHeight)
    return () => ro.disconnect()
  }, [])

  const [topbarPinned, setTopbarPinned] = useState(true)

  // ── Topbar hide-on-scroll (mobile only) ───────────────
  // Topbar is position:fixed on mobile so hiding/showing it never changes
  // <main>'s dimensions — no scrollTop clamping, no layout-driven jitter.
  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    let lastY = 0
    const onScroll = () => {
      if (!matchMedia('(max-width: 767px)').matches) return
      const y = el.scrollTop
      if (y <= 10) {
        setTopbarPinned(true)
      } else if (y > lastY + 4) {
        setTopbarPinned(false)
      } else if (y < lastY - 4) {
        setTopbarPinned(true)
      }
      lastY = y
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // ── Channel page state ────────────────────────────────
  const [channelWindow, setChannelWindow] = useState('1m')
  const [channelSort, setChannelSort] = useState('likes')
  const [channelTimeMode, setChannelTimeMode] = useState('wide')

  // ── URL sync ──────────────────────────────────────────
  // replaceState for reactive filter changes (tags, window, sort) — no new history entry
  const syncUrl = useCallback(() => {
    if (selectedVideoId) return  // watch overlay owns the /watch/{id} URL
    if (page === 'search') return  // search URL (?q=) is managed by onSearchChange
    if (page === 'playlist') return  // /playlist/{id} is navigated directly
    const path = buildPath(page, selectedChannelId, selectedTags, timeWindow, sort, timeMode, channelsSort, contentMode === 'shorts')
    if (location.pathname + location.search !== path) {
      history.replaceState(null, '', path)
    }
  }, [selectedVideoId, page, selectedChannelId, selectedTags, timeWindow, sort, timeMode, channelsSort, contentMode])

  // Sync URL on filter state changes (replaceState — no new history entry)
  useEffect(() => { syncUrl() }, [syncUrl])

  // Listen for browser back/forward
  useEffect(() => {
    const onPop = () => {
      const p = parsePath()
      if (p.videoId) {
        // Show/keep the watch overlay; the underlying page stays mounted and
        // untouched (no scroll reset, no refetch).
        setSelectedVideo(null)  // refetch metadata by id
        setSelectedVideoId(p.videoId)
        overlayOpenRef.current = true
        return
      }
      if (overlayOpenRef.current) {
        // Just closing the overlay onto the page we came from — it's already
        // correct and mounted, so leave its scroll and data exactly as they were.
        overlayOpenRef.current = false
        setSelectedVideoId(null)
        setSelectedVideo(null)
        return
      }
      // A genuine page navigation (back/forward between real pages).
      const q = parseSearch()
      setPageRaw(p.page)
      setSearchInput(new URLSearchParams(window.location.search).get('q') || '')
      setSelectedChannelId(p.channelId)
      setSelectedPlaylistId(p.playlistId)
      setSelectedTags(q.tags)
      setTimeWindow(q.window)
      setSort(q.sort)
      setTimeMode(q.timeMode)
      setChannelsSort(q.channelsSort)
      setContentMode(q.shorts ? 'shorts' : 'videos')
      mainRef.current?.scrollTo({ top: 0 })
      setTopbarPinned(true)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // A card was opened (VideoCard dispatches 'app:watch' rather than drilling a
  // nav callback through every feed surface). openWatch only calls stable
  // setters, so capturing it once is fine.
  useEffect(() => {
    const onWatch = (e: Event) => openWatch((e as CustomEvent<VideoItem>).detail)
    window.addEventListener('app:watch', onWatch)
    return () => window.removeEventListener('app:watch', onWatch)
  }, [])

  // ── Auto-refresh via Page Visibility API ────────────────
  const lastFetchRef = useRef(Date.now())
  const visibilityTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  const startTimer = useCallback((interval: number) => {
    if (visibilityTimerRef.current) clearInterval(visibilityTimerRef.current)
    visibilityTimerRef.current = setInterval(() => {
      lastFetchRef.current = Date.now()
      refreshRef.current()
    }, interval)
  }, []) // stable: refresh is not in deps, it's called dynamically

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Reactivated: check if overdue
        const elapsed = Date.now() - lastFetchRef.current
        if (elapsed > ACTIVE_INTERVAL) {
          lastFetchRef.current = Date.now()
          refreshRef.current()
        }
        startTimer(ACTIVE_INTERVAL)
      } else {
        // Went inactive
        startTimer(INACTIVE_INTERVAL)
      }
    }

    // Initial setup
    startTimer(document.visibilityState === 'visible' ? ACTIVE_INTERVAL : INACTIVE_INTERVAL)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      if (visibilityTimerRef.current) clearInterval(visibilityTimerRef.current)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [startTimer])

  // ── Data fetching ─────────────────────────────────────
  const [tagChannels, setTagChannels] = useState<Map<string, Set<string>>>(new Map())

  // Per-tag channel count that updates as tags are selected.
  // For tags in a group that already has selections, count uses the filter from
  // ALL OTHER groups only (so sibling tags show how many would match if chosen instead).
  // For tags in groups with no selections, count uses the full cross-group filter.
  const tagFilteredCounts = useMemo(() => {
    if (selectedTags.length === 0) return null

    const byGroup = new Map<string, string[]>()
    for (const t of selectedTags) {
      const group = tags.find(x => x.name === t)?.group ?? '__ungrouped__'
      byGroup.set(group, [...(byGroup.get(group) ?? []), t])
    }

    const intersect = (sets: Set<string>[]): Set<string> =>
      sets.reduce<Set<string> | null>((acc, s) => acc === null ? s : new Set([...acc].filter(id => s.has(id))), null) ?? new Set()

    // Precompute "filter excluding group G" for each group that has selections
    const filterWithoutGroup = new Map<string, Set<string> | null>()
    for (const [excludeGroup] of byGroup) {
      const otherGroupSets = [...byGroup.entries()]
        .filter(([g]) => g !== excludeGroup)
        .map(([, groupTags]) => new Set(groupTags.flatMap(t => [...(tagChannels.get(t) ?? [])])))
      filterWithoutGroup.set(excludeGroup, otherGroupSets.length > 0 ? intersect(otherGroupSets) : null)
    }

    // Full cross-group filter (for tags in groups with no selections)
    const allGroupSets = [...byGroup.values()].map(groupTags =>
      new Set(groupTags.flatMap(t => [...(tagChannels.get(t) ?? [])]))
    )
    const fullFilter = intersect(allGroupSets)

    const counts = new Map<string, number>()
    for (const tag of tags) {
      const group = tag.group ?? '__ungrouped__'
      const tagIds = tagChannels.get(tag.name) ?? new Set<string>()
      const baseFilter = byGroup.has(group) ? filterWithoutGroup.get(group)! : fullFilter
      counts.set(tag.name, baseFilter === null ? tagIds.size : [...tagIds].filter(id => baseFilter.has(id)).length)
    }
    return counts
  }, [selectedTags, tags, tagChannels])

  const fetchTags = useCallback(async () => {
    try {
      const [tagsRes, channelsRes] = await Promise.all([
        fetch('/api/tags'),
        fetch('/api/tags/channels'),
      ])
      setTags(await tagsRes.json())
      const channelMap: Record<string, string[]> = await channelsRes.json()
      const reverse = new Map<string, Set<string>>()
      for (const [channelId, tagNames] of Object.entries(channelMap)) {
        for (const tag of tagNames) {
          if (!reverse.has(tag)) reverse.set(tag, new Set())
          reverse.get(tag)!.add(channelId)
        }
      }
      setTagChannels(reverse)
    } catch (e) {
      console.error('Failed to fetch tags:', e)
    }
  }, [])

  useEffect(() => { fetchTags() }, [fetchTags])

  // Warm the YouTube IFrame API shortly after mount so the first hover preview
  // doesn't also wait on that script download. Deferred so it doesn't compete
  // with the initial render / first feed fetch.
  useEffect(() => {
    const id = setTimeout(preloadYouTubeApi, 1500)
    return () => clearTimeout(id)
  }, [])

  // Fetch one page of the feed; append to the existing list unless replacing.
  const fetchFeedPage = useCallback(async (offset: number, replace: boolean, size = FEED_PAGE_SIZE) => {
    const params = new URLSearchParams({
      window: timeWindow, sort, time_mode: timeMode,
      shorts: String(contentMode === 'shorts'),
      offset: String(offset), limit: String(size),
    })
    if (selectedTags.length > 0) params.set('tags', selectedTags.join(','))
    if (showHidden) params.set('include_hidden', 'true')
    const res = await fetch(`/api/tags/feed?${params}`)
    const data = await res.json()
    setFeedTotal(data.total || 0)
    setFeed((prev) => {
      const existing = replace || !prev ? [] : prev.groups[0].videos
      return {
        categories: [],
        groups: [{ name: 'Feed', icon: '', sort_order: 0, videos: [...existing, ...(data.videos || [])] }],
        window: data.window,
      }
    })
  }, [timeWindow, sort, timeMode, selectedTags, contentMode, showHidden])

  const fetchFeed = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true)
      setFeed(null)
      setFeedTotal(0)
    }
    try {
      // A background refresh re-fetches the pages already loaded (so a scrolled
      // list doesn't snap back to the first page); a fresh load starts at page 1.
      const size = background ? Math.max(FEED_PAGE_SIZE, feedLoadedRef.current) : FEED_PAGE_SIZE
      await fetchFeedPage(0, true, size)
    } catch (e) {
      console.error('Failed to fetch feed:', e)
    }
    if (!background) setLoading(false)
  }, [fetchFeedPage])

  const loadMoreFeed = useCallback(async () => {
    if (feedLoadingMoreRef.current) return
    const current = feed?.groups[0]?.videos.length ?? 0
    if (current >= feedTotal) return
    feedLoadingMoreRef.current = true
    try {
      await fetchFeedPage(current, false)
    } catch (e) {
      console.error('Failed to load more:', e)
    } finally {
      feedLoadingMoreRef.current = false
    }
  }, [feed, feedTotal, fetchFeedPage])

  useEffect(() => {
    if (page === 'feed') fetchFeed()
  }, [page, fetchFeed])

  // Track how many feed videos are loaded (used by background refresh).
  useEffect(() => { feedLoadedRef.current = feed?.groups[0]?.videos.length ?? 0 }, [feed])

  // ── Actions ───────────────────────────────────────────
  // pushState for explicit navigations (page/channel changes create a history entry)
  const setPage = useCallback((p: 'feed' | 'channels' | 'channel' | 'watchlater' | 'downloads' | 'playlists') => {
    const newChannelId = p !== 'channel' ? null : selectedChannelId
    history.pushState(null, '', buildPath(p, newChannelId, selectedTags, timeWindow, sort, timeMode, channelsSort, contentMode === 'shorts'))
    setPageRaw(p)
    setSelectedPlaylistId(null)
    mainRef.current?.scrollTo({ top: 0 })
    setTopbarPinned(true)
    if (p !== 'channel') setSelectedChannelId(null)
    if (p === 'channel') {
      setChannelWindow('1m')
      setChannelSort('likes')
      setChannelTimeMode('wide')
    }
    if (p !== 'feed') setMobileMenuOpen(false)
  }, [selectedChannelId, selectedTags, timeWindow, sort, timeMode, channelsSort])

  // Search box: typing routes to the /search page; the URL tracks the query.
  const onSearchChange = useCallback((q: string) => {
    setSearchInput(q)
    if (!q.trim()) {
      // Cleared the box.
      if (searchPushedRef.current) {
        // Still in the search session we pushed → return to the page (and state)
        // we searched from, via the popstate handler. Fall back to the feed if
        // there's nothing to return to (app opened directly on /search).
        searchPushedRef.current = false
        if (window.history.length > 1) {
          history.back()
        } else {
          setPageRaw('feed')
          history.replaceState(null, '', '/')
        }
      }
      // Otherwise we've already navigated to a result (e.g. a channel page); just
      // clear the leftover text and stay on that page — don't open a blank search.
      return
    }
    if (!searchPushedRef.current) {
      // Entering search: push one history entry so we can return to the current
      // page when the box is cleared. The ref guards against a second push if
      // several keystrokes land before the re-render.
      searchPushedRef.current = true
      history.pushState(null, '', `/search?q=${encodeURIComponent(q)}`)
      setPageRaw('search')
      return
    }
    history.replaceState(null, '', `/search?q=${encodeURIComponent(q)}`)
  }, [])

  // Refocusing the box while it still holds a query returns to the results page
  // (the query now persists across navigation, so the text can outlive /search).
  const onSearchFocus = useCallback(() => {
    if (!searchInput.trim() || page === 'search') return
    searchPushedRef.current = true
    history.pushState(null, '', `/search?q=${encodeURIComponent(searchInput)}`)
    setPageRaw('search')
  }, [searchInput, page])

  // Leaving the search page by any route (nav, channel open, browser back) ends
  // the search session, so the next search pushes a fresh returnable entry.
  useEffect(() => {
    if (page !== 'search') searchPushedRef.current = false
  }, [page])

  function toggleTag(tag: string) {
    setSelectedTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    )
  }

  // Read-only reload for the auto-refresh timer. Scanning YouTube is now owned
  // by the backend scheduler, so the frontend only re-reads the locally-cached
  // feed to pick up whatever the last backend scan wrote — no scan is triggered.
  async function refresh() {
    lastFetchRef.current = Date.now()
    try {
      await fetchTags()
      if (page === 'feed') await fetchFeed(true)
    } catch (e) {
      console.error('Reload failed:', e)
    }
  }

  function selectChannel(channelId: string) {
    history.pushState(null, '', buildPath('channel', channelId, selectedTags, timeWindow, sort, timeMode, channelsSort, contentMode === 'shorts'))
    setSelectedChannelId(channelId)
    setSelectedPlaylistId(null)
    setPageRaw('channel')
    setChannelWindow('1m')
    setChannelSort('likes')
    setChannelTimeMode('wide')
    mainRef.current?.scrollTo({ top: 0 })
  }

  function selectPlaylist(id: number) {
    history.pushState(null, '', `/playlist/${id}`)
    setSelectedPlaylistId(id)
    setPageRaw('playlist')
    mainRef.current?.scrollTo({ top: 0 })
  }

  // Open a video as a full-screen overlay (from a card's plain-click, via the
  // 'app:watch' event). We DON'T touch the underlying page or its scroll — it
  // stays mounted behind the overlay, so closing returns you exactly where you
  // were. We carry the VideoItem so the overlay renders instantly.
  function openWatch(video: VideoItem) {
    history.pushState(null, '', `/watch/${video.youtube_id}`)
    setSelectedVideo(video)
    setSelectedVideoId(video.youtube_id)
    overlayOpenRef.current = true
  }

  // Clicking the channel from the watch overlay: close the overlay and navigate
  // to the channel page (a forward navigation).
  function selectChannelFromWatch(channelId: string) {
    overlayOpenRef.current = false
    setSelectedVideoId(null)
    setSelectedVideo(null)
    selectChannel(channelId)
  }

  function goHome() {
    history.pushState(null, '', '/')
    setSelectedTags([])
    setSelectedChannelId(null)
    setSelectedPlaylistId(null)
    setPageRaw('feed')
    setTimeWindow('3d')
    setSort('likes')
    setTimeMode('wide')
    mainRef.current?.scrollTo({ top: 0 })
    setTopbarPinned(true)
  }

  function clearFilter() {
    setSelectedTags([])
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar — full height (contains the logo); overlay on mobile. */}
      <div className={`${mobileMenuOpen ? 'fixed inset-y-0 left-0 z-40' : 'hidden'} md:flex md:relative md:z-auto`}>
        <Sidebar
          tags={tags}
          selectedTags={selectedTags}
          onToggleTag={toggleTag}
          onSetTags={setSelectedTags}
          page={page}
          onPageChange={setPage}
          onHome={goHome}
          onToggleCollapse={() => {
            if (matchMedia('(max-width: 767px)').matches) {
              setMobileMenuOpen(prev => !prev)
            } else {
              setSidebarCollapsed(prev => !prev)
            }
          }}
          downloadsCount={downloads.length}
          playlistsCount={playlists.length}
          onClearFilter={clearFilter}
          collapsed={sidebarCollapsed}
          watchLaterCount={watchLater.length}
          tagFilteredCounts={tagFilteredCounts}
          hiddenCount={hiddenChannels.size}
          showHidden={showHidden}
          onToggleShowHidden={() => setShowHidden(v => !v)}
          contentMode={contentMode}
          onContentModeChange={setContentMode}
        />
      </div>

      {/* Right column: token banner + topbar + main content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* YouTube API token expired/revoked — stats stop updating until re-auth */}
        {tokenBad && !tokenNoticeDismissed && (
          <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2 text-sm bg-amber-500/15 text-amber-300 border-b border-amber-500/30">
            <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86l-8.48 14.7A2 2 0 003.53 21h16.94a2 2 0 001.72-2.44l-8.48-14.7a2 2 0 00-3.42 0z"/>
            </svg>
            <span className="flex-1 min-w-0">
              YouTube API token is expired/revoked — video stats will stop updating.{' '}
              <a
                href="/api/auth/login"
                target="_blank"
                rel="noreferrer"
                className="underline font-semibold text-amber-200 hover:text-amber-100"
              >
                Re-authenticate
              </a>{' '}to resume.
            </span>
            <button
              className="flex-shrink-0 text-amber-300/70 hover:text-amber-200 text-xs px-2 py-0.5"
              onClick={() => { sessionStorage.setItem('yt_token_notice_dismissed', '1'); setTokenNoticeDismissed(true) }}
            >
              Dismiss
            </button>
          </div>
        )}
      <main ref={mainRef} className="flex-1 overflow-y-auto min-w-0 mb-14 md:mb-0 [overflow-anchor:none] [scrollbar-gutter:stable]" style={isMobile ? { paddingTop: topbarHeight } : undefined}>
        {/* TopBar lives INSIDE the scroll container so scrolling works natively
            even when the cursor rests on it. Desktop: sticky at the top. Mobile:
            fixed (out of flow) and slides up/down on scroll — main's paddingTop
            reserves the space. */}
        <div
          ref={topbarRef}
          className={`fixed top-0 inset-x-0 z-20 transition-transform duration-200 md:sticky md:top-0 md:translate-y-0 ${topbarPinned ? 'translate-y-0' : '-translate-y-full'}`}
        >
        <TopBar
          variant={page === 'channels' ? 'channels' : page === 'channel' ? 'channel' : page === 'watchlater' ? 'watchlater' : page === 'downloads' ? 'downloads' : page === 'search' ? 'search' : page === 'playlists' || page === 'playlist' ? 'playlists' : 'feed'}
          searchQuery={searchInput}
          onSearchChange={onSearchChange}
          onSearchFocus={onSearchFocus}
          window={page === 'channel' ? channelWindow : timeWindow}
          onWindowChange={page === 'channel' ? setChannelWindow : setTimeWindow}
          sort={page === 'channel' ? channelSort : sort}
          onSortChange={page === 'channel' ? setChannelSort : setSort}
          timeMode={page === 'channel' ? channelTimeMode : timeMode}
          onTimeModeChange={page === 'channel' ? setChannelTimeMode : setTimeMode}
          channelsSort={channelsSort}
          onChannelsSortChange={setChannelsSort}
          onToggleCollapse={() => {
            if (matchMedia('(max-width: 767px)').matches) {
              setMobileMenuOpen(prev => !prev)
            } else {
              setSidebarCollapsed(prev => !prev)
            }
          }}
        />
        </div>

        {selectedTags.length > 0 && (
          <div className="sticky z-10 px-4 py-2 border-b border-[#272727] bg-[#0d0d0d] flex items-center gap-2" style={{ top: isMobile ? 0 : topbarHeight }}>
            <span className="text-xs text-[#555] font-medium">Filters:</span>
            <div className="flex flex-wrap gap-1.5">
              {selectedTags.map((tag) => {
                const info = tags.find(t => t.name === tag)
                return (
                  <button
                    key={tag}
                    onClick={() => toggleTag(tag)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full bg-white text-black font-medium hover:opacity-80 transition-opacity"
                  >
                    <span>{info?.icon || '🏷️'}</span>
                    <span>{tag}</span>
                    <span className="ml-0.5 text-black/40 font-bold">×</span>
                  </button>
                )
              })}
            </div>
            <button
              onClick={clearFilter}
              className="ml-1 text-xs text-[#555] hover:text-white transition-colors"
            >
              Clear
            </button>
          </div>
        )}
        {page === 'search' ? (
          <SearchPage
            query={searchInput}
            onChannelClick={selectChannel}
            sort={sort}
            watchLaterIds={watchLaterIds}
            onToggleWatchLater={toggleWatchLater}
            onDownload={startDownload}
            downloadIds={downloadIds}
            onHideChannel={hideChannel}
          />
        ) : page === 'playlists' ? (
          <PlaylistsPage playlists={playlists} onOpen={selectPlaylist} onDelete={deletePlaylist} />
        ) : page === 'playlist' && selectedPlaylistId != null ? (
          <PlaylistPage
            playlistId={selectedPlaylistId}
            onChannelClick={selectChannel}
            watchLaterIds={watchLaterIds}
            onToggleWatchLater={toggleWatchLater}
            onDownload={startDownload}
            downloadIds={downloadIds}
            onHideChannel={hideChannel}
            onDeleted={() => setPage('playlists')}
          />
        ) : page === 'downloads' ? (
          <DownloadsPage downloads={downloads} onDelete={deleteDownload} onRetry={startDownload} />
        ) : page === 'watchlater' ? (
          <div className="px-6 py-4">
            {watchLater.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 gap-3 text-[#aaa]">
                <svg className="w-12 h-12 text-[#444]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
                </svg>
                <p className="text-sm">No videos saved yet.</p>
                <p className="text-xs text-[#555]">Hover a video and click the bookmark icon to save it.</p>
              </div>
            ) : (() => {
              let result = filterWatchLater(watchLater, timeWindow, timeMode)
              if (selectedTags.length > 0) {
                // Group selected tags by section, OR within group, AND across groups
                const byGroup = new Map<string, string[]>()
                for (const t of selectedTags) {
                  const group = tags.find(x => x.name === t)?.group ?? '__ungrouped__'
                  byGroup.set(group, [...(byGroup.get(group) ?? []), t])
                }
                const allowed = [...byGroup.values()].reduce<Set<string> | null>((acc, groupTags) => {
                  const ids = new Set(groupTags.flatMap(t => [...(tagChannels.get(t) ?? [])]))
                  return acc === null ? ids : new Set([...acc].filter(id => ids.has(id)))
                }, null) ?? new Set()
                result = result.filter(v => allowed.has(v.channel_id))
              }
              result = sortWatchLater(result, sort)
              return result.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-[#717171] text-sm">
                  No saved videos match the current filters.
                </div>
              ) : (
                <VideoRow
                  group={{ name: 'Watch Later', icon: '', sort_order: 0, videos: result }}
                  onChannelClick={selectChannel}
                  sort={sort}
                  watchLaterIds={watchLaterIds}
                  onToggleWatchLater={toggleWatchLater}
                  onDownload={startDownload}
                  downloadIds={downloadIds}
                />
              )
            })()}
          </div>
        ) : page === 'channel' && selectedChannelId ? (
          <ChannelPage
            channelId={selectedChannelId}
            timeWindow={channelWindow}
            onTimeWindowChange={setChannelWindow}
            sort={channelSort}
            onSortChange={setChannelSort}
            timeMode={channelTimeMode}
            onTimeModeChange={setChannelTimeMode}
            watchLaterIds={watchLaterIds}
            onToggleWatchLater={toggleWatchLater}
            onDownload={startDownload}
            downloadIds={downloadIds}
            onHideChannel={hideChannel}
            shorts={contentMode === 'shorts'}
          />
        ) : page === 'feed' ? (
          <div className="px-6 py-4">
            {!feed ? (
              loading ? (
                <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
                  Loading feed...
                </div>
              ) : (
                <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
                  No data yet.
                </div>
              )
            ) : (() => {
              const raw = feed.groups[0]
              const loaded = raw?.videos.length ?? 0
              const hasMore = loaded < feedTotal
              // Drop hidden channels' videos from the home feed (unless "show hidden").
              const videos = (hiddenChannels.size === 0 || showHidden)
                ? raw?.videos ?? []
                : (raw?.videos ?? []).filter((v) => !hiddenChannels.has(v.channel_id))
              // Only show an empty-state once there are no more pages to load.
              if (videos.length === 0 && !hasMore) {
                return (
                  <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
                    {hiddenChannels.size > 0 && !showHidden
                      ? 'All channels here are hidden from home.'
                      : 'No videos found.'}
                  </div>
                )
              }
              return (
                <VideoRow
                  key="feed"
                  group={{ name: 'Feed', icon: '', sort_order: 0, videos }}
                  onChannelClick={selectChannel}
                  sort={sort}
                  watchLaterIds={watchLaterIds}
                  onToggleWatchLater={toggleWatchLater}
                  onDownload={startDownload}
                  downloadIds={downloadIds}
                  onHideChannel={hideChannel}
                  totalCount={feedTotal}
                  onLoadMore={loadMoreFeed}
                  hasMore={hasMore}
                />
              )
            })()}
          </div>
        ) : (
          <ChannelsPage selectedTags={selectedTags} onSelectChannel={selectChannel} sort={channelsSort} onSortChange={setChannelsSort} hiddenChannels={hiddenChannels} onToggleHidden={toggleHiddenChannel} />
        )}
      </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-50 bg-[#0f0f0f] border-t border-[#272727] flex">
        <button
          onClick={goHome}
          className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-colors ${page === 'feed' ? 'text-white' : 'text-[#717171]'}`}
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
          <span className="text-[10px]">My Feed</span>
        </button>
        <button
          onClick={() => setPage('channels')}
          className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-colors ${page === 'channels' ? 'text-white' : 'text-[#717171]'}`}
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>
          <span className="text-[10px]">Channels</span>
        </button>
        <button
          onClick={() => setPage('watchlater')}
          className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-colors relative ${page === 'watchlater' ? 'text-white' : 'text-[#717171]'}`}
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>
          <span className="text-[10px]">Watch Later</span>
          {!!watchLater.length && (
            <span className="absolute top-1.5 right-[calc(50%-14px)] text-[9px] bg-blue-500 text-white rounded-full w-4 h-4 flex items-center justify-center font-bold">
              {watchLater.length > 9 ? '9+' : watchLater.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setPage('downloads')}
          className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-colors relative ${page === 'downloads' ? 'text-white' : 'text-[#717171]'}`}
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
          <span className="text-[10px]">Downloads</span>
          {!!downloads.length && (
            <span className="absolute top-1.5 right-[calc(50%-16px)] text-[9px] bg-blue-500 text-white rounded-full w-4 h-4 flex items-center justify-center font-bold">
              {downloads.length > 9 ? '9+' : downloads.length}
            </span>
          )}
        </button>
      </nav>

      {/* Watch overlay — full-screen, above everything (sidebar z-40, nav z-50).
          Rendered outside the page switch so the page underneath stays mounted
          with its scroll and loaded data intact; closing returns you there. */}
      {selectedVideoId && (
        <div className="fixed inset-0 z-[60] bg-[#0f0f0f] overflow-y-auto">
          <WatchPage
            key={selectedVideoId}
            videoId={selectedVideoId}
            video={selectedVideo}
            onChannelClick={selectChannelFromWatch}
            onDownload={startDownload}
            isDownloaded={downloadIds.has(selectedVideoId)}
          />
        </div>
      )}
    </div>
  )
}