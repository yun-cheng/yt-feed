import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { apiFetch } from './lib/api'
import Toaster from './components/Toaster'
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
import ImportedPage from './components/ImportedPage'
import HistoryPage from './components/HistoryPage'
import ImportDialog from './components/ImportDialog'
import type { ImportResult } from './components/ImportDialog'
import LocalPage, { addLocalFolder } from './components/LocalPage'
import LocalFolderPage from './components/LocalFolderPage'
import LocalWatchPage from './components/LocalWatchPage'
import { fetchFolders, fetchFolderVideos } from './lib/local'
import type { LocalFolder, LocalVideo } from './lib/local'
import { DEFAULT_RANGE, formatAge, parseAge, rangeBounds, rangeFromLegacy } from './lib/timeWindow'
import type { TimeRange } from './lib/timeWindow'

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
  // Channel-specific labels drawn from the title (channel page only).
  // undefined = not present in payload; null = not labeled yet; [] = no labels.
  title_labels?: string[] | null
}

// A video you've watched (or started): a feed video plus where you got to.
export type HistoryItem = VideoItem & {
  position_seconds: number
  watched: boolean
  watched_at: string | null
}

// What a card needs to draw its resume bar — the subset of HistoryItem the
// feed/grid pass around, keyed by video id.
export type WatchProgress = {
  position_seconds: number
  watched: boolean
}

export type TagInfo = {
  name: string
  group: string
  icon: string
  channel_count: number
}

// A channel-page topic chip: a title-derived label and its whole-channel count.
export type LabelCount = {
  name: string
  count: number
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
  age: string
}

// ── Watch status ────────────────────────────────────────────

// The three states a video can be in. Derived from watch history, not stored:
// no entry = never opened, an entry = started, an entry with `watched` = finished.
export const WATCH_STATUSES = [
  { value: 'unwatched', label: 'Unwatched', icon: '🆕' },
  { value: 'in_progress', label: 'In progress', icon: '▶️' },
  { value: 'watched', label: 'Watched', icon: '✅' },
] as const

// Watched is off by default: the home feed is for finding something to watch,
// and things you've already seen are noise there.
export const DEFAULT_WATCH_STATUSES = ['unwatched', 'in_progress']

// The History page only ever lists videos you've started, so 'unwatched' has
// nothing to match there and isn't offered.
export const HISTORY_WATCH_OPTIONS = WATCH_STATUSES.filter(w => w.value !== 'unwatched')
const WATCH_STATUS_KEY = 'watch_statuses'

export function loadWatchStatuses(): string[] {
  // The URL is the source of truth (see parseQuery); this is the fallback for a
  // cold load with no `watch` param — your last choice, remembered.
  try {
    const raw = JSON.parse(localStorage.getItem(WATCH_STATUS_KEY) || 'null')
    if (Array.isArray(raw) && raw.every(v => typeof v === 'string')) return raw
  } catch { /* fall through to the default */ }
  return DEFAULT_WATCH_STATUSES
}

// ── URL helpers ─────────────────────────────────────────────

// NB: there's no 'watch' page — /watch/:id is a full-screen overlay rendered on
// top of whichever page you were on (see selectedVideoId), so that page stays
// mounted underneath with its scroll and loaded videos intact.
// 'local' is the list of local folders; 'localfolder' is one folder's videos.
// /local/:folderId/:videoId is likewise an OVERLAY over the folder page.
type Page = 'feed' | 'channels' | 'channel' | 'watchlater' | 'downloads' | 'search' | 'playlists' | 'playlist' | 'imported' | 'history' | 'local' | 'localfolder'

type PathState = {
  page: Page
  channelId: string | null
  playlistId: number | null
  videoId: string | null
  localFolderId: number | null
  localVideoId: string | null
}

function parsePath(): PathState {
  const path = window.location.pathname
  const base = { channelId: null, playlistId: null, videoId: null, localFolderId: null, localVideoId: null }
  if (path === '/channels') return { page: 'channels', ...base }
  if (path === '/watchlater') return { page: 'watchlater', ...base }
  if (path === '/downloads') return { page: 'downloads', ...base }
  if (path === '/imported') return { page: 'imported', ...base }
  if (path === '/history') return { page: 'history', ...base }
  if (path === '/search') return { page: 'search', ...base }
  if (path === '/playlists') return { page: 'playlists', ...base }
  if (path === '/local') return { page: 'local', ...base }
  // /local/:folderId, optionally with a video — the video is an overlay over the
  // folder page, the same arrangement /watch/:id has over the feed.
  const lm = path.match(/^\/local\/(\d+)(?:\/([^/]+))?/)
  if (lm) return { page: 'localfolder', ...base, localFolderId: Number(lm[1]), localVideoId: lm[2] ?? null }
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

// Every filter and sort the UI exposes is mirrored in the query string, so a
// refresh — or a pasted link — lands on the same view.
//
// Pages keep SEPARATE sort / window / watch-status state (a channel page's sort
// isn't the feed's), but the URL carries one of each: the page being shown owns
// them, and every other page's copy sits at its own default. A value equal to
// that default is left out, so ordinary URLs stay short.
const PAGE_DEFAULTS: Record<string, { age: string; sort: string; watch: string[] }> = {
  feed: { age: '0-3', sort: 'likes', watch: DEFAULT_WATCH_STATUSES },
  watchlater: { age: '0-3', sort: 'likes', watch: DEFAULT_WATCH_STATUSES },
  // A channel page opens on a wider window (one channel posts far less often)
  // and with nothing filtered out — you came to see what it has.
  channel: { age: '0-30', sort: 'likes', watch: [] },
  channels: { age: '0-3', sort: 'subs', watch: [] },
  // Imported and History lead with 'recent' — the order the API returns them in.
  // Imported shares the global watch-status selection (like Watch Later), so it
  // shares its default too; History keeps its own, which starts unfiltered.
  imported: { age: '0-3', sort: 'recent', watch: DEFAULT_WATCH_STATUSES },
  history: { age: '0-3', sort: 'recent', watch: [] },
}
const DEFAULTS = PAGE_DEFAULTS.feed
const defaultsFor = (page: string) => PAGE_DEFAULTS[page] ?? DEFAULTS
/** A page's opening window, as the ticks the slider speaks. */
const defaultRange = (page: string) => parseAge(defaultsFor(page).age) ?? DEFAULT_RANGE

// Which controls each page actually has. A param a page can't change is never
// written, so a URL only ever shows filters that page offers.
//
// These same sets decide what the sidebar renders: a filter that can't change
// what you're looking at shouldn't be there to click, and it shouldn't be in the
// URL either. One table, so the two can't disagree.
const USES_WINDOW = new Set(['feed', 'watchlater', 'channel'])
const USES_SORT = new Set(['feed', 'watchlater', 'channel', 'channels', 'imported', 'history'])
const USES_WATCH = new Set(['feed', 'watchlater', 'channel', 'history', 'imported'])
const USES_SHORTS = new Set(['feed', 'channel', 'history'])
// Tags are attached to channels, so they only filter lists of subscribed
// channels' videos. A channel page swaps them for that channel's own topics;
// imported videos come from channels you don't follow and have no tags at all.
const USES_TAGS = new Set(['feed', 'watchlater', 'history', 'channels'])
// "Show hidden channels" only changes the home feed's query.
const USES_HIDDEN = new Set(['feed'])

// What the sidebar should offer on a given page.
export const pageFilters = (page: string) => ({
  watchStatus: USES_WATCH.has(page),
  tags: USES_TAGS.has(page),
  hidden: USES_HIDDEN.has(page),
  contentMode: USES_SHORTS.has(page),
})

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(v => b.includes(v))

type QueryState = {
  tags: string[]
  age: TimeRange
  sort: string
  shorts: boolean
  // null = absent from the URL, so use the page's default. [] = an explicit
  // "no filter" (?watch=none) — not the same thing.
  watch: string[] | null
  label: string | null
  showHidden: boolean
  q: string
}

function parseQuery(page: Page): QueryState {
  const p = new URLSearchParams(window.location.search)
  const d = defaultsFor(page)
  const watch = p.get('watch')
  return {
    tags: p.get('tags')?.split(',').filter(Boolean) ?? [],
    // `window` + `time_mode` are the pre-slider spelling. They still resolve, so
    // old bookmarks land on the range they always meant.
    age: parseAge(p.get('age'))
      ?? rangeFromLegacy(p.get('window'), p.get('time_mode'))
      ?? parseAge(d.age)
      ?? DEFAULT_RANGE,
    sort: p.get('sort') || d.sort,
    shorts: p.get('shorts') === '1',
    watch: watch === null ? null : watch === 'none' ? [] : watch.split(',').filter(Boolean),
    label: p.get('label'),
    showHidden: p.get('hidden') === '1',
    q: p.get('q') || '',
  }
}

export type UrlState = {
  page: string
  channelId?: string | null
  tags?: string[]
  age?: TimeRange
  sort?: string
  shorts?: boolean
  watch?: string[]
  label?: string | null
  showHidden?: boolean
  q?: string
}

export function buildPath(s: UrlState): string {
  const { page } = s
  const d = defaultsFor(page)
  const params = new URLSearchParams()
  if (USES_TAGS.has(page) && s.tags?.length) params.set('tags', s.tags.join(','))
  if (USES_WINDOW.has(page) && s.age) {
    const age = formatAge(s.age)
    if (age !== d.age) params.set('age', age)
  }
  if (USES_SORT.has(page) && s.sort && s.sort !== d.sort) params.set('sort', s.sort)
  if (USES_SHORTS.has(page) && s.shorts) params.set('shorts', '1')
  if (USES_WATCH.has(page) && s.watch && !sameSet(s.watch, d.watch)) {
    // Selecting nothing means "no filter", which has to be spelled out — an
    // absent param means "use the default", and here they differ.
    params.set('watch', s.watch.length ? s.watch.join(',') : 'none')
  }
  if (page === 'channel' && s.label) params.set('label', s.label)
  if (USES_HIDDEN.has(page) && s.showHidden) params.set('hidden', '1')
  if (page === 'search' && s.q) params.set('q', s.q)
  const qs = params.toString()

  const path = page === 'feed' ? '/'
    : page === 'channel' && s.channelId ? `/channel/${s.channelId}`
    // A folder's own path is /local/:id, pushed directly (like /playlist/:id).
    : page === 'localfolder' ? '/local'
    : `/${page}`
  return qs ? `${path}?${qs}` : path
}

// Map the URL onto app state: whichever page is showing takes the URL's sort /
// window / watch values, everything else starts at its own default. Used both
// on a cold load and on back/forward, so the two can't drift apart.
function stateFromUrl() {
  const path = parsePath()
  const q = parseQuery(path.page)
  const owns = (...pages: Page[]) => pages.includes(path.page)
  return {
    ...path,
    q: q.q,
    tags: q.tags,
    contentMode: (q.shorts ? 'shorts' : 'videos') as 'videos' | 'shorts',
    showHidden: q.showHidden,
    age: owns('channel') ? (parseAge(DEFAULTS.age) ?? DEFAULT_RANGE) : q.age,
    channelAge: owns('channel') ? q.age : (parseAge(PAGE_DEFAULTS.channel.age) ?? DEFAULT_RANGE),
    sort: owns('feed', 'watchlater') ? q.sort : DEFAULTS.sort,
    channelsSort: owns('channels') ? q.sort : PAGE_DEFAULTS.channels.sort,
    channelSort: owns('channel') ? q.sort : PAGE_DEFAULTS.channel.sort,
    importedSort: owns('imported') ? q.sort : PAGE_DEFAULTS.imported.sort,
    historySort: owns('history') ? q.sort : PAGE_DEFAULTS.history.sort,
    watchStatuses: owns('feed', 'watchlater', 'imported') && q.watch !== null ? q.watch : loadWatchStatuses(),
    channelWatchStatuses: owns('channel') && q.watch !== null ? q.watch : [],
    historyWatchStatuses: owns('history') && q.watch !== null ? q.watch : [],
    selectedLabel: owns('channel') ? q.label : null,
  }
}

// ── Watch Later helpers ──────────────────────────────────────

// Watch Later is filtered here rather than by the API, but to the same bounds
// the backend would apply — one range, one pair of comparisons.
export function filterWatchLater(videos: VideoItem[], age: TimeRange): VideoItem[] {
  const { from, to } = rangeBounds(age, Date.now())
  return videos.filter(v => {
    const t = new Date(v.published_at).getTime()
    return t >= from && t < to
  })
}

export function watchStatusOf(videoId: string, progressById: Map<string, WatchProgress>): string {
  const p = progressById.get(videoId)
  if (!p) return 'unwatched'
  return p.watched ? 'watched' : 'in_progress'
}

// Selecting every status — or none — means "don't filter", matching both the tag
// filter and the backend's `watch` param, so an empty selection can never leave
// you staring at a blank page wondering why.
export function filterByWatchStatus<T extends VideoItem>(
  videos: T[],
  statuses: string[],
  progressById: Map<string, WatchProgress>,
): T[] {
  if (statuses.length === 0 || statuses.length >= WATCH_STATUSES.length) return videos
  return videos.filter(v => statuses.includes(watchStatusOf(v.youtube_id, progressById)))
}

// Apply the sidebar's tag selection to an already-loaded list: OR within a tag
// group (section), AND across groups — the same rule the backend's /tags/feed
// uses, so a filtered feed and a filtered library agree.
export function filterByTags<T extends VideoItem>(
  videos: T[],
  selectedTags: string[],
  tags: TagInfo[],
  tagChannels: Map<string, Set<string>>,
): T[] {
  if (selectedTags.length === 0) return videos
  const byGroup = new Map<string, string[]>()
  for (const t of selectedTags) {
    const group = tags.find(x => x.name === t)?.group ?? '__ungrouped__'
    byGroup.set(group, [...(byGroup.get(group) ?? []), t])
  }
  const allowed = [...byGroup.values()].reduce<Set<string> | null>((acc, groupTags) => {
    const ids = new Set(groupTags.flatMap(t => [...(tagChannels.get(t) ?? [])]))
    return acc === null ? ids : new Set([...acc].filter(id => ids.has(id)))
  }, null) ?? new Set<string>()
  return videos.filter(v => allowed.has(v.channel_id))
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
  const init = stateFromUrl()
  const [page, setPageRaw] = useState<Page>(init.page)
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | null>(init.playlistId)
  // In-app watch page: the video id from the URL, plus the VideoItem we arrived
  // with (null on cold load / back-forward, where WatchPage fetches by id).
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(init.videoId)
  const [selectedVideo, setSelectedVideo] = useState<VideoItem | null>(null)
  // Whether the watch overlay is currently open — lets popstate tell "closing
  // the overlay" (leave the underlying page untouched) from a real page nav.
  const overlayOpenRef = useRef<boolean>(!!init.videoId)
  const [searchInput, setSearchInput] = useState<string>(init.q)
  // True once we've pushed a /search history entry, so clearing the box can go
  // back() to the page (and its state) we were on before searching.
  const searchPushedRef = useRef(false)
  const [feed, setFeed] = useState<FeedResponse | null>(null)
  const [feedTotal, setFeedTotal] = useState(0)          // total ranked videos in the window
  const feedLoadedRef = useRef(0)                          // videos currently loaded (for bg refresh)
  const feedLoadingMoreRef = useRef(false)                 // guard against overlapping page fetches
  const [tags, setTags] = useState<TagInfo[]>([])
  const [selectedTags, setSelectedTags] = useState<string[]>(init.tags)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(init.channelId)
  // Channel-page video-label filtering: the current channel's label vocabulary
  // (its sidebar chips) and the single selected label. Owned here because the
  // sidebar (which renders the chips) lives in App while ChannelPage does the
  // filtering. null vocab = not built yet.
  const [channelLabelVocab, setChannelLabelVocab] = useState<LabelCount[] | null>(null)
  const [channelLabelsBuilding, setChannelLabelsBuilding] = useState(false)
  const [channelHasTopics, setChannelHasTopics] = useState(false)
  const [selectedLabel, setSelectedLabel] = useState<string | null>(init.selectedLabel)
  const [loading, setLoading] = useState(true)
  const [age, setAge] = useState(init.age)
  const [sort, setSort] = useState(init.sort)
  const [channelsSort, setChannelsSort] = useState(init.channelsSort)
  // Videos ↔ Shorts: switches the feed / channel pages between long-form and
  // vertical short-form. Shorts live on a separate channel tab and rank very
  // differently, so they're a distinct browse mode rather than mixed in.
  // Persisted in the URL (?shorts=1) so a reload/shared link lands on the same mode.
  const [contentMode, setContentMode] = useState<'videos' | 'shorts'>(init.contentMode)

  // ── Watch Later ───────────────────────────────────────
  const [watchLater, setWatchLater] = useState<VideoItem[]>([])
  const watchLaterIds = useMemo(() => new Set(watchLater.map(v => v.youtube_id)), [watchLater])

  const fetchWatchLater = useCallback(async () => {
    try {
      const res = await apiFetch('/api/watch-later')
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
            apiFetch('/api/watch-later', {
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
      apiFetch(`/api/watch-later/${video.youtube_id}`, { method: 'DELETE' }).catch(() => {})
    } else {
      apiFetch('/api/watch-later', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(video),
      }).catch(() => {})
    }
  }

  // ── Hidden channels (excluded from the home feed) ─────
  // Server-side now (syncs across devices); the feed query already excludes them.
  const [hiddenChannels, setHiddenChannels] = useState<Set<string>>(new Set())
  // When on, hidden channels' videos are shown in the feed anyway (a temporary peek).
  const [showHidden, setShowHidden] = useState(init.showHidden)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // One-time migration of the old browser-local hidden list, then forget it.
      try {
        const legacy = localStorage.getItem('hidden_channels')
        if (legacy !== null) {
          const ids: string[] = JSON.parse(legacy) || []
          if (ids.length > 0) {
            await apiFetch('/api/hidden-channels/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ channel_ids: ids }),
            })
          }
          localStorage.removeItem('hidden_channels')
        }
      } catch { /* ignore malformed legacy data */ }
      try {
        const res = await apiFetch('/api/hidden-channels')
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
    apiFetch(`/api/hidden-channels/${channelId}`, { method: 'POST' }).catch(() => {})
  }
  // From the Channels page: flip a channel's hidden state (optimistic).
  function toggleHiddenChannel(channelId: string) {
    const wasHidden = hiddenChannels.has(channelId)
    setHiddenChannels(prev => {
      const next = new Set(prev)
      wasHidden ? next.delete(channelId) : next.add(channelId)
      return next
    })
    apiFetch(`/api/hidden-channels/${channelId}`, { method: wasHidden ? 'DELETE' : 'POST' }).catch(() => {})
  }

  // ── Playlists (server-side) ───────────────────────────
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([])
  const fetchPlaylists = useCallback(async () => {
    try {
      const res = await apiFetch('/api/playlists')
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
    try { await apiFetch(`/api/playlists/${id}`, { method: 'DELETE' }) } catch { /* ignore */ }
    fetchPlaylists()
  }, [fetchPlaylists])

  // ── Downloads (server-side offline library) ───────────
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const downloadIds = useMemo(() => new Set(downloads.map(d => d.youtube_id)), [downloads])
  // Only 'ready' has a playable file on disk — a queued or failed download has a
  // row but nothing to serve, so the watch page must still use the embed.
  const readyDownloadIds = useMemo(
    () => new Set(downloads.filter(d => d.status === 'ready').map(d => d.youtube_id)),
    [downloads],
  )

  // Whether the list has come back at least once. The watch overlay waits for
  // this before picking a player, so a cold load of /watch/:id can't decide
  // "not downloaded" from a list that simply hasn't arrived yet. A failed fetch
  // still counts as an answer — the overlay falls back to the embed.
  const [downloadsKnown, setDownloadsKnown] = useState(false)

  const fetchDownloads = useCallback(async () => {
    try {
      const res = await apiFetch('/api/downloads')
      if (res.ok) setDownloads(await res.json())
    } catch { /* ignore */ }
    finally { setDownloadsKnown(true) }
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
      await apiFetch('/api/downloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      })
    } catch { /* ignore */ }
    fetchDownloads()
  }, [fetchDownloads])

  const deleteDownload = useCallback(async (videoId: string) => {
    setDownloads(prev => prev.filter(d => d.youtube_id !== videoId))
    try { await apiFetch(`/api/downloads/${videoId}`, { method: 'DELETE' }) } catch { /* ignore */ }
  }, [])

  // ── Imported videos ───────────────────────────────────
  // Videos added by pasting a link, from channels you don't follow. They live in
  // their own table server-side (the feed only ever queries subscribed channels),
  // but arrive shaped like feed videos so the same cards and actions apply.
  const [imported, setImported] = useState<VideoItem[]>([])
  const [importOpen, setImportOpen] = useState(false)
  // The Imported page has no time window, and its default order is import order
  // — so it keeps its own sort rather than sharing the feed's.
  const [importedSort, setImportedSort] = useState(init.importedSort)

  const fetchImported = useCallback(async () => {
    try {
      const res = await apiFetch('/api/imported')
      if (res.ok) setImported(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { fetchImported() }, [fetchImported])

  const importVideos = useCallback(async (urls: string): Promise<ImportResult> => {
    const res = await apiFetch('/api/imported', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
    })
    const data: ImportResult = await res.json()
    if (data.added?.length) await fetchImported()
    return { added: data.added ?? [], skipped: data.skipped ?? [], failed: data.failed ?? [] }
  }, [fetchImported])

  const removeImported = useCallback(async (video: VideoItem) => {
    setImported(prev => prev.filter(v => v.youtube_id !== video.youtube_id))
    try { await apiFetch(`/api/imported/${video.youtube_id}`, { method: 'DELETE' }) } catch { /* ignore */ }
  }, [])

  // ── Local folders ─────────────────────────────────────
  // A directory on the backend's machine, listed as a feed. The folder's videos
  // live here rather than in the folder page so the watch overlay can read the
  // same list (its up-next column) and a position written by the player shows up
  // on the grid behind it.
  const [localFolders, setLocalFolders] = useState<LocalFolder[]>([])
  const [localFolderId, setLocalFolderId] = useState<number | null>(init.localFolderId)
  const [localFolderMeta, setLocalFolderMeta] = useState<LocalFolder | null>(null)
  const [localVideos, setLocalVideos] = useState<LocalVideo[]>([])
  const [localScanning, setLocalScanning] = useState(false)
  const [localLoading, setLocalLoading] = useState(false)
  const [selectedLocalVideoId, setSelectedLocalVideoId] = useState<string | null>(init.localVideoId)

  const fetchLocalFolders = useCallback(async () => {
    setLocalFolders(await fetchFolders())
  }, [])
  useEffect(() => { fetchLocalFolders() }, [fetchLocalFolders])

  // Load the open folder. `rescan` walks the directory first (the files are the
  // source of truth); the poll below re-reads without walking.
  const loadLocalVideos = useCallback(async (folderId: number, rescan = true) => {
    const data = await fetchFolderVideos(folderId, rescan)
    if (!data) return
    setLocalFolderMeta(data.folder)
    setLocalVideos(data.videos)
    setLocalScanning(data.scanning)
  }, [])

  useEffect(() => {
    if (localFolderId === null) return
    let cancelled = false
    setLocalLoading(true)
    setLocalVideos([])
    ;(async () => {
      await loadLocalVideos(localFolderId)
      if (!cancelled) setLocalLoading(false)
    })()
    return () => { cancelled = true }
  }, [localFolderId, loadLocalVideos])

  // Durations are measured in the background (reading a file on a cloud-synced
  // drive streams it down), so poll until the backend says it's finished.
  useEffect(() => {
    if (localFolderId === null || !localScanning) return
    const id = setInterval(() => loadLocalVideos(localFolderId, false), 3000)
    return () => clearInterval(id)
  }, [localFolderId, localScanning, loadLocalVideos])

  const addLocalFolderPath = useCallback(async (path: string) => {
    const err = await addLocalFolder(path)
    if (!err) await fetchLocalFolders()
    return err
  }, [fetchLocalFolders])

  const removeLocalFolder = useCallback(async (folderId: number) => {
    setLocalFolders(prev => prev.filter(f => f.id !== folderId))
    try { await apiFetch(`/api/local/folders/${folderId}`, { method: 'DELETE' }) } catch { /* ignore */ }
    fetchLocalFolders()
  }, [fetchLocalFolders])

  const selectedLocalVideo = useMemo(
    () => localVideos.find(v => v.id === selectedLocalVideoId) ?? null,
    [localVideos, selectedLocalVideoId],
  )

  // ── Watch history ─────────────────────────────────────
  // Where you got to in every video you've opened. Feeds three things: the
  // History page, the resume bar drawn on every card, and the watch page's
  // "continue where you left off". Written by WatchPage while a video plays.
  const [watchHistory, setWatchHistory] = useState<HistoryItem[]>([])
  const [historySort, setHistorySort] = useState(init.historySort)

  const fetchHistory = useCallback(async () => {
    try {
      const res = await apiFetch('/api/history', { quiet: true })
      if (res.ok) setWatchHistory(await res.json())
    } catch { /* ignore */ }
  }, [])

  // Load on mount, and again every time the watch overlay closes — that's when
  // a position has just changed, and it's what makes the card behind it show
  // its new resume bar immediately.
  useEffect(() => { if (!selectedVideoId) fetchHistory() }, [selectedVideoId, fetchHistory])

  // Card lookup: every grid gets this one map rather than the whole list.
  const progressById = useMemo(
    () => new Map<string, WatchProgress>(
      watchHistory.map(h => [h.youtube_id, { position_seconds: h.position_seconds, watched: h.watched }])
    ),
    [watchHistory]
  )

  const removeHistory = useCallback(async (video: VideoItem) => {
    setWatchHistory(prev => prev.filter(v => v.youtube_id !== video.youtube_id))
    try { await apiFetch(`/api/history/${video.youtube_id}`, { method: 'DELETE' }) } catch { /* ignore */ }
  }, [])

  // ── YouTube API token health (reminder to re-auth) ────
  const [tokenBad, setTokenBad] = useState(false)
  const [tokenNoticeDismissed, setTokenNoticeDismissed] = useState(
    () => sessionStorage.getItem('yt_token_notice_dismissed') === '1'
  )
  const checkToken = useCallback((force = false) => {
    apiFetch(`/api/youtube-token${force ? '?force=1' : ''}`, { quiet: true })
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

  // Reset the channel-label chips whenever the viewed channel changes, so one
  // channel's topics never leak onto another's sidebar. The *selection* is
  // cleared by the navigation itself (selectChannel / setPage), not here —
  // otherwise this would wipe a `?label=` restored from the URL on a cold load.
  useEffect(() => {
    setChannelLabelVocab(null)
    setChannelLabelsBuilding(false)
    setChannelHasTopics(false)
  }, [selectedChannelId])

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
  const [channelAge, setChannelAge] = useState(init.channelAge)
  const [channelSort, setChannelSort] = useState(init.channelSort)

  // ── URL sync ──────────────────────────────────────────
  // (currentPath / syncUrl live further down — they read the watch-status state,
  // which is declared with the rest of the filtering below.)

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
      if (p.localVideoId) {
        // Same arrangement for a local folder's video (see parsePath).
        setSelectedLocalVideoId(p.localVideoId)
        if (p.localFolderId !== null) setLocalFolderId(p.localFolderId)
        overlayOpenRef.current = true
        return
      }
      if (overlayOpenRef.current) {
        // Just closing the overlay onto the page we came from — it's already
        // correct and mounted, so leave its scroll and data exactly as they were.
        overlayOpenRef.current = false
        setSelectedVideoId(null)
        setSelectedVideo(null)
        setSelectedLocalVideoId(null)
        return
      }
      // A genuine page navigation (back/forward between real pages): rebuild
      // every filter from the URL, the same mapping a cold load uses.
      const s = stateFromUrl()
      setPageRaw(s.page)
      setSearchInput(s.q)
      setSelectedChannelId(s.channelId)
      setSelectedPlaylistId(s.playlistId)
      setLocalFolderId(s.localFolderId)
      setSelectedLocalVideoId(null)
      setSelectedTags(s.tags)
      setAge(s.age)
      setSort(s.sort)
      setChannelsSort(s.channelsSort)
      setChannelAge(s.channelAge)
      setChannelSort(s.channelSort)
      setImportedSort(s.importedSort)
      setHistorySort(s.historySort)
      setContentMode(s.contentMode)
      setShowHidden(s.showHidden)
      setWatchStatuses(s.watchStatuses)
      setChannelWatchStatuses(s.channelWatchStatuses)
      setHistoryWatchStatuses(s.historyWatchStatuses)
      setSelectedLabel(s.selectedLabel)
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

  // Watch-status filter (sidebar). Global, like the tag selection — the feed
  // applies it server-side so paging stays honest; the already-loaded libraries
  // apply it themselves below.
  const [watchStatuses, setWatchStatuses] = useState<string[]>(init.watchStatuses)
  useEffect(() => {
    try { localStorage.setItem(WATCH_STATUS_KEY, JSON.stringify(watchStatuses)) } catch { /* private mode */ }
  }, [watchStatuses])
  const toggleWatchStatus = useCallback((value: string) => {
    setWatchStatuses(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value])
  }, [])

  // History keeps its own selection rather than sharing the global one, which
  // hides watched videos — backwards on a page whose whole job is to list what
  // you've watched. It starts EMPTY (no filter) and is cleared again by every
  // navigation to the page (see setPage): a filter you set last time is a
  // surprise waiting for you, and the useful default here is "show everything".
  // A reload is not a fresh visit, so `?watch=` in the URL still wins.
  const [historyWatchStatuses, setHistoryWatchStatuses] = useState<string[]>(init.historyWatchStatuses)
  const toggleHistoryWatchStatus = useCallback((value: string) => {
    setHistoryWatchStatuses(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value])
  }, [])

  // A channel page filters its own list the same way, and likewise starts with
  // nothing selected — you open a channel to see what it has, not what's left of
  // it. Cleared by each navigation to a channel, so one channel's filter doesn't
  // follow you to the next — but a reload of a `?watch=` URL keeps it.
  const [channelWatchStatuses, setChannelWatchStatuses] = useState<string[]>(init.channelWatchStatuses)
  const toggleChannelWatchStatus = useCallback((value: string) => {
    setChannelWatchStatuses(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value])
  }, [])

  // History obeys the same two global controls as the feed: the Videos/Shorts
  // toggle and the sidebar's tag selection. Both are applied client-side — the
  // list is already loaded, and it's small.
  const visibleHistory = useMemo(() => {
    const shorts = contentMode === 'shorts'
    const byMode = watchHistory.filter(v => !!v.is_short === shorts)
    const byStatus = filterByWatchStatus(byMode, historyWatchStatuses, progressById)
    return filterByTags(byStatus, selectedTags, tags, tagChannels)
  }, [watchHistory, contentMode, selectedTags, tags, tagChannels, historyWatchStatuses, progressById])

  // Imported videos take the global watch-status filter, like Watch Later. Tags
  // don't apply — these come from channels you don't follow, so none of them are
  // tagged — and neither does the Videos/Shorts toggle: it's one flat list.
  const visibleImported = useMemo(
    () => filterByWatchStatus(imported, watchStatuses, progressById),
    [imported, watchStatuses, progressById],
  )

  // ── URL sync (continued) ──────────────────────────────
  // The whole current view as a URL. Everything funnels through here, so a
  // navigation only has to name its page: this fills in that page's filters.
  const currentPath = useCallback(() => buildPath({
    page,
    channelId: selectedChannelId,
    tags: selectedTags,
    age: page === 'channel' ? channelAge : age,
    sort: page === 'channel' ? channelSort
      : page === 'channels' ? channelsSort
      : page === 'imported' ? importedSort
      : page === 'history' ? historySort
      : sort,
    shorts: contentMode === 'shorts',
    watch: page === 'channel' ? channelWatchStatuses
      : page === 'history' ? historyWatchStatuses
      : watchStatuses,
    label: selectedLabel,
    showHidden,
    q: searchInput,
  }), [page, selectedChannelId, selectedTags, age, sort, channelsSort,
    channelAge, channelSort, importedSort, historySort, contentMode,
    watchStatuses, channelWatchStatuses, historyWatchStatuses, selectedLabel, showHidden, searchInput])

  // replaceState for reactive filter changes (tags, window, sort, …) — no new history entry
  const syncUrl = useCallback(() => {
    if (selectedVideoId || selectedLocalVideoId) return  // an overlay owns the URL
    if (page === 'playlist') return  // /playlist/{id} is navigated directly
    if (page === 'localfolder') return  // ditto /local/{id}
    const path = currentPath()
    if (location.pathname + location.search !== path) {
      history.replaceState(null, '', path)
    }
  }, [selectedVideoId, selectedLocalVideoId, page, currentPath])

  // Sync URL on filter state changes (replaceState — no new history entry)
  useEffect(() => { syncUrl() }, [syncUrl])


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
        apiFetch('/api/tags'),
        apiFetch('/api/tags/channels'),
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
      age: formatAge(age), sort,
      shorts: String(contentMode === 'shorts'),
      offset: String(offset), limit: String(size),
    })
    if (selectedTags.length > 0) params.set('tags', selectedTags.join(','))
    if (watchStatuses.length > 0) params.set('watch', watchStatuses.join(','))
    if (showHidden) params.set('include_hidden', 'true')
    const res = await apiFetch(`/api/tags/feed?${params}`)
    const data = await res.json()
    setFeedTotal(data.total || 0)
    setFeed((prev) => {
      const existing = replace || !prev ? [] : prev.groups[0].videos
      return {
        categories: [],
        groups: [{ name: 'Feed', icon: '', sort_order: 0, videos: [...existing, ...(data.videos || [])] }],
        age: data.age,
      }
    })
  }, [age, sort, selectedTags, contentMode, showHidden, watchStatuses])

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
  const setPage = useCallback((p: 'feed' | 'channels' | 'channel' | 'watchlater' | 'downloads' | 'playlists' | 'imported' | 'history' | 'local') => {
    // Push the bare page path; the URL-sync effect appends that page's filters
    // (replaceState) once the state below has settled.
    history.pushState(null, '', buildPath({ page: p, channelId: selectedChannelId, tags: selectedTags }))
    setPageRaw(p)
    setSelectedPlaylistId(null)
    mainRef.current?.scrollTo({ top: 0 })
    setTopbarPinned(true)
    if (p !== 'channel') {
      setSelectedChannelId(null)
      setSelectedLabel(null)
      setChannelWatchStatuses([])
    }
    if (p === 'channel') {
      setChannelAge(defaultRange('channel'))
      setChannelSort(PAGE_DEFAULTS.channel.sort)
    }
    // Every visit to History starts unfiltered — see historyWatchStatuses.
    if (p === 'history') setHistoryWatchStatuses([])
    if (p === 'local') { setLocalFolderId(null); setSelectedLocalVideoId(null) }
    if (p !== 'feed') setMobileMenuOpen(false)
  }, [selectedChannelId, selectedTags])

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
      history.pushState(null, '', buildPath({ page: 'search', q }))
      setPageRaw('search')
      return
    }
    history.replaceState(null, '', buildPath({ page: 'search', q }))
  }, [])

  // Refocusing the box while it still holds a query returns to the results page
  // (the query now persists across navigation, so the text can outlive /search).
  const onSearchFocus = useCallback(() => {
    if (!searchInput.trim() || page === 'search') return
    searchPushedRef.current = true
    history.pushState(null, '', buildPath({ page: 'search', q: searchInput }))
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
    history.pushState(null, '', buildPath({ page: 'channel', channelId, tags: selectedTags }))
    setSelectedChannelId(channelId)
    setSelectedPlaylistId(null)
    setPageRaw('channel')
    setChannelAge(defaultRange('channel'))
    setChannelSort(PAGE_DEFAULTS.channel.sort)
    setChannelWatchStatuses([])
    setSelectedLabel(null)
    mainRef.current?.scrollTo({ top: 0 })
  }

  // Open one local folder's videos (a forward navigation, like a playlist).
  function selectLocalFolder(id: number) {
    history.pushState(null, '', `/local/${id}`)
    setLocalFolderId(id)
    setSelectedLocalVideoId(null)
    setPageRaw('localfolder')
    mainRef.current?.scrollTo({ top: 0 })
  }

  // Play a local video: an overlay over the folder page, which stays mounted
  // underneath (same contract as openWatch).
  function openLocalVideo(video: LocalVideo) {
    history.pushState(null, '', `/local/${video.folder_id}/${video.id}`)
    setSelectedLocalVideoId(video.id)
    overlayOpenRef.current = true
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
    history.pushState(null, '', buildPath({ page: 'feed', shorts: contentMode === 'shorts' }))
    setSelectedTags([])
    setWatchStatuses(DEFAULT_WATCH_STATUSES)
    setSelectedChannelId(null)
    setSelectedPlaylistId(null)
    setSelectedLabel(null)
    setPageRaw('feed')
    setAge(defaultRange('feed'))
    setSort(DEFAULTS.sort)
    mainRef.current?.scrollTo({ top: 0 })
    setTopbarPinned(true)
  }

  function clearFilter() {
    setSelectedTags([])
  }

  // Which sidebar sections this page can actually use.
  const sidebarFilters = pageFilters(page)

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
          importedCount={imported.length}
          localFoldersCount={localFolders.length}
          playlistsCount={playlists.length}
          onClearFilter={clearFilter}
          collapsed={sidebarCollapsed}
          watchLaterCount={watchLater.length}
          tagFilteredCounts={tagFilteredCounts}
          hiddenCount={hiddenChannels.size}
          showHidden={showHidden}
          onToggleShowHidden={() => setShowHidden(v => !v)}
          watchStatuses={page === 'history' ? historyWatchStatuses : page === 'channel' ? channelWatchStatuses : watchStatuses}
          onToggleWatchStatus={page === 'history' ? toggleHistoryWatchStatus : page === 'channel' ? toggleChannelWatchStatus : toggleWatchStatus}
          watchStatusOptions={page === 'history' ? HISTORY_WATCH_OPTIONS : WATCH_STATUSES}
          filters={sidebarFilters}
          contentMode={contentMode}
          onContentModeChange={setContentMode}
          channelMode={page === 'channel'}
          channelLabels={channelLabelVocab}
          channelLabelsBuilding={channelLabelsBuilding}
          channelHasTopics={channelHasTopics}
          selectedLabel={selectedLabel}
          onToggleLabel={(l) => setSelectedLabel((cur) => (cur === l ? null : l))}
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
          variant={page === 'channels' ? 'channels' : page === 'channel' ? 'channel' : page === 'watchlater' ? 'watchlater' : page === 'downloads' ? 'downloads' : page === 'search' ? 'search' : page === 'imported' ? 'imported' : page === 'history' ? 'history' : page === 'playlists' || page === 'playlist' ? 'playlists' : page === 'local' || page === 'localfolder' ? 'local' : 'feed'}
          onImport={page === 'imported' ? () => setImportOpen(true) : undefined}
          searchQuery={searchInput}
          onSearchChange={onSearchChange}
          onSearchFocus={onSearchFocus}
          age={page === 'channel' ? channelAge : age}
          onAgeChange={page === 'channel' ? setChannelAge : setAge}
          count={page === 'feed' ? feedTotal : undefined}
          sort={page === 'channel' ? channelSort : page === 'imported' ? importedSort : page === 'history' ? historySort : sort}
          onSortChange={page === 'channel' ? setChannelSort : page === 'imported' ? setImportedSort : page === 'history' ? setHistorySort : setSort}
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

        {selectedTags.length > 0 && sidebarFilters.tags && (
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
            progressById={progressById}
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
            progressById={progressById}
            onDeleted={() => setPage('playlists')}
          />
        ) : page === 'history' ? (
          <HistoryPage
            history={visibleHistory}
            totalCount={watchHistory.length}
            sort={historySort}
            progressById={progressById}
            onChannelClick={selectChannel}
            watchLaterIds={watchLaterIds}
            onToggleWatchLater={toggleWatchLater}
            onDownload={startDownload}
            downloadIds={downloadIds}
            onRemoveHistory={removeHistory}
          />
        ) : page === 'imported' ? (
          <ImportedPage
            videos={visibleImported}
            totalCount={imported.length}
            sort={importedSort}
            onChannelClick={selectChannel}
            watchLaterIds={watchLaterIds}
            onToggleWatchLater={toggleWatchLater}
            onDownload={startDownload}
            downloadIds={downloadIds}
            progressById={progressById}
            onRemoveImported={removeImported}
            onImport={() => setImportOpen(true)}
          />
        ) : page === 'local' ? (
          <LocalPage
            folders={localFolders}
            onOpen={selectLocalFolder}
            onAdd={addLocalFolderPath}
            onRemove={removeLocalFolder}
          />
        ) : page === 'localfolder' ? (
          <LocalFolderPage
            folder={localFolderMeta}
            videos={localVideos}
            scanning={localScanning}
            loading={localLoading}
            onBack={() => setPage('local')}
            onRescan={() => { if (localFolderId !== null) loadLocalVideos(localFolderId) }}
            onOpen={openLocalVideo}
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
              let result = filterWatchLater(watchLater, age)
              result = filterByTags(result, selectedTags, tags, tagChannels)
              result = filterByWatchStatus(result, watchStatuses, progressById)
              result = sortWatchLater(result, sort)
              return result.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-[#717171] text-sm">
                  No saved videos match the current filters.
                </div>
              ) : (
                <VideoRow
                  group={{ name: 'Watch Later', icon: '', sort_order: 0, videos: result }}
                  progressById={progressById}
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
            age={channelAge}
            sort={channelSort}
            onSortChange={setChannelSort}
            watchLaterIds={watchLaterIds}
            onToggleWatchLater={toggleWatchLater}
            onDownload={startDownload}
            downloadIds={downloadIds}
            onHideChannel={hideChannel}
            shorts={contentMode === 'shorts'}
            labelFilter={selectedLabel}
            onVocabChange={setChannelLabelVocab}
            onBuildingChange={setChannelLabelsBuilding}
            onHasTopicsChange={setChannelHasTopics}
            progressById={progressById}
            watchStatuses={channelWatchStatuses}
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
                    {watchStatuses.length > 0 && watchStatuses.length < WATCH_STATUSES.length
                      ? 'No videos match the watch status filter.'
                      : hiddenChannels.size > 0 && !showHidden
                        ? 'All channels here are hidden from home.'
                        : 'No videos found.'}
                  </div>
                )
              }
              return (
                <VideoRow
                  key="feed"
                  progressById={progressById}
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
            hasLocalFile={readyDownloadIds.has(selectedVideoId)}
            downloadsKnown={downloadsKnown}
          />
        </div>
      )}
      {/* Local-video overlay — same layering and close-by-back behaviour as the
          watch overlay above; the folder grid stays mounted behind it. */}
      {selectedLocalVideo && (
        <div className="fixed inset-0 z-[60] bg-[#0f0f0f]">
          <LocalWatchPage
            key={selectedLocalVideo.id}
            video={selectedLocalVideo}
            folder={localFolderMeta}
            siblings={localVideos}
            onClose={() => history.back()}
            onSelect={openLocalVideo}
            onProgress={() => { if (localFolderId !== null) loadLocalVideos(localFolderId, false) }}
          />
        </div>
      )}
      {importOpen && (
        <ImportDialog onClose={() => setImportOpen(false)} onImport={importVideos} />
      )}
      <Toaster />
    </div>
  )
}