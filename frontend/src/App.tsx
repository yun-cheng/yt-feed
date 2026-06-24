import { useState, useEffect, useCallback, useRef } from 'react'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import VideoRow from './components/VideoRow'
import ChannelsPage from './components/ChannelsPage'
import ChannelPage from './components/ChannelPage'

export type VideoItem = {
  youtube_id: string
  title: string
  channel_id: string
  channel_name?: string
  thumbnail_url: string
  published_at: string
  view_count: number
  like_count: number
  duration_seconds: number
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

function parsePath(): { page: 'feed' | 'channels' | 'channel'; channelId: string | null } {
  const path = window.location.pathname
  if (path === '/channels') return { page: 'channels', channelId: null }
  const m = path.match(/^\/channel\/([^/]+)/)
  if (m) return { page: 'channel', channelId: m[1] }
  return { page: 'feed', channelId: null }
}

function parseSearch(): { tags: string[]; window: string; sort: string; timeMode: string; channelsSort: string } {
  const p = new URLSearchParams(window.location.search)
  const rawSort = p.get('sort')
  return {
    tags: p.get('tags') ? p.get('tags')!.split(',').filter(Boolean) : [],
    window: p.get('window') || '1d',
    sort: rawSort || 'score',
    timeMode: p.get('time_mode') || 'narrow',
    channelsSort: rawSort || 'subs',
  }
}

function buildPath(
  page: string,
  channelId: string | null,
  tags: string[],
  window: string,
  sort: string,
  timeMode: string,
  channelsSort: string,
): string {
  const params = new URLSearchParams()
  if (tags.length > 0) params.set('tags', tags.join(','))
  if (window !== '1d') params.set('window', window)
  if (page === 'channels') {
    if (channelsSort !== 'subs') params.set('sort', channelsSort)
  } else {
    if (sort !== 'score') params.set('sort', sort)
  }
  if (timeMode !== 'narrow') params.set('time_mode', timeMode)
  const qs = params.toString()

  if (page === 'channels') return qs ? `/channels?${qs}` : '/channels'
  if (page === 'channel' && channelId) {
    return qs ? `/channel/${channelId}?${qs}` : `/channel/${channelId}`
  }
  // feed
  return qs ? `/?${qs}` : '/'
}

// ── App ─────────────────────────────────────────────────────

const ACTIVE_INTERVAL = 5 * 60 * 1000  // 5 min when visible
const INACTIVE_INTERVAL = 15 * 60 * 1000  // 15 min when hidden

export default function App() {
  // Init from URL
  const initPath = parsePath()
  const initQ = parseSearch()
  const [page, setPageRaw] = useState<'feed' | 'channels' | 'channel'>(initPath.page)
  const [feed, setFeed] = useState<FeedResponse | null>(null)
  const [tags, setTags] = useState<TagInfo[]>([])
  const [selectedTags, setSelectedTags] = useState<string[]>(initQ.tags)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(initPath.channelId)
  const [loading, setLoading] = useState(true)
  const [window, setWindow] = useState(initQ.window)
  const [sort, setSort] = useState(initQ.sort)
  const [timeMode, setTimeMode] = useState(initQ.timeMode)
  const [channelsSort, setChannelsSort] = useState(initQ.channelsSort)
  const [refreshing, setRefreshing] = useState(false)

  // ── Channel page takeover state ──────────────────────
  const [channelControlsScrolledAway, setChannelControlsScrolledAway] = useState(false)
  const [channelWindow, setChannelWindow] = useState('1w')
  const [channelSort, setChannelSort] = useState('score')
  const [channelTimeMode, setChannelTimeMode] = useState('narrow')

  // ── URL sync ──────────────────────────────────────────
  // replaceState for reactive filter changes (tags, window, sort) — no new history entry
  const syncUrl = useCallback(() => {
    const path = buildPath(page, selectedChannelId, selectedTags, window, sort, timeMode, channelsSort)
    if (location.pathname + location.search !== path) {
      history.replaceState(null, '', path)
    }
  }, [page, selectedChannelId, selectedTags, window, sort, timeMode, channelsSort])

  // Sync URL on filter state changes (replaceState — no new history entry)
  useEffect(() => { syncUrl() }, [syncUrl])

  // Listen for browser back/forward
  useEffect(() => {
    const onPop = () => {
      const p = parsePath()
      const q = parseSearch()
      setPageRaw(p.page)
      setSelectedChannelId(p.channelId)
      setSelectedTags(q.tags)
      setWindow(q.window)
      setSort(q.sort)
      setTimeMode(q.timeMode)
      setChannelsSort(q.channelsSort)
    }
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
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
  const fetchTags = useCallback(async () => {
    try {
      const res = await fetch('/api/tags')
      setTags(await res.json())
    } catch (e) {
      console.error('Failed to fetch tags:', e)
    }
  }, [])

  useEffect(() => { fetchTags() }, [fetchTags])

  const fetchFeed = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ window, sort, time_mode: timeMode })
      if (selectedTags.length > 0) params.set('tags', selectedTags.join(','))
      const url = `/api/tags/feed?${params}`
      const res = await fetch(url)
      const data = await res.json()
      setFeed({
        categories: [],
        groups: [{
          name: 'Feed',
          icon: '',
          sort_order: 0,
          videos: data.videos || [],
        }],
        window: data.window,
      })
    } catch (e) {
      console.error('Failed to fetch feed:', e)
    }
    setLoading(false)
  }, [window, sort, timeMode, selectedTags, tags])

  useEffect(() => {
    if (page === 'feed') fetchFeed()
  }, [page, fetchFeed])

  // ── Actions ───────────────────────────────────────────
  // pushState for explicit navigations (page/channel changes create a history entry)
  const setPage = useCallback((p: 'feed' | 'channels' | 'channel') => {
    const newChannelId = p !== 'channel' ? null : selectedChannelId
    history.pushState(null, '', buildPath(p, newChannelId, selectedTags, window, sort, timeMode, channelsSort))
    setPageRaw(p)
    if (p !== 'channel') setSelectedChannelId(null)
  }, [selectedChannelId, selectedTags, window, sort, timeMode, channelsSort])

  function toggleTag(tag: string) {
    setSelectedTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    )
  }

  async function refresh() {
    lastFetchRef.current = Date.now()
    setRefreshing(true)
    try {
      // Trigger background scan
      const res = await fetch('/api/refresh', { method: 'POST' })
      const { status } = await res.json()
      if (status === 'started' || status === 'already_running') {
        // Poll until done
        while (true) {
          await new Promise(r => setTimeout(r, 2000))
          const sres = await fetch('/api/refresh/status')
          const { running } = await sres.json()
          if (!running) break
        }
      }
      // Re-fetch everything
      await fetchTags()
      if (page === 'feed') await fetchFeed()
    } catch (e) {
      console.error('Refresh failed:', e)
    }
    setRefreshing(false)
  }

  function selectChannel(channelId: string) {
    history.pushState(null, '', buildPath('channel', channelId, selectedTags, window, sort, timeMode, channelsSort))
    setSelectedChannelId(channelId)
    setPageRaw('channel')
  }

  function backToChannels() {
    // Use history.back() to avoid pushing a duplicate /channels entry.
    // Fall back to replaceState when there's no history to go back to.
    if (history.length > 1) {
      history.back()
    } else {
      history.replaceState(null, '', '/channels')
      setSelectedChannelId(null)
      setPageRaw('channels')
    }
  }

  function goHome() {
    history.pushState(null, '', '/')
    setSelectedTags([])
    setSelectedChannelId(null)
    setPageRaw('feed')
    setWindow('1w')
    setSort('score')
    setTimeMode('narrow')
  }

  function clearFilter() {
    setSelectedTags([])
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        tags={tags}
        selectedTags={selectedTags}
        onToggleTag={toggleTag}
        page={page}
        onPageChange={setPage}
        onClearFilter={clearFilter}
        onHome={refresh}
      />

      <main className="flex-1 overflow-y-auto">
        <TopBar
          variant={page === 'channels' ? 'channels' : page === 'channel' ? 'channel' : 'feed'}
          window={window}
          onWindowChange={setWindow}
          sort={sort}
          onSortChange={setSort}
          timeMode={timeMode}
          onTimeModeChange={setTimeMode}
          channelsSort={channelsSort}
          onChannelsSortChange={setChannelsSort}
          selectedTags={selectedTags}
          tags={tags}
          onToggleTag={toggleTag}
          onClearFilter={clearFilter}
          hideControls={page === 'channel'}
          showTakeover={page === 'channel' && channelControlsScrolledAway}
          takeoverWindow={channelWindow}
          takeoverSort={channelSort}
          takeoverTimeMode={channelTimeMode}
          onTakeoverWindowChange={setChannelWindow}
          onTakeoverSortChange={setChannelSort}
          onTakeoverTimeModeChange={setChannelTimeMode}
        />

        {page === 'channel' && selectedChannelId ? (
          <ChannelPage
            channelId={selectedChannelId}
            onBack={backToChannels}
            timeWindow={channelWindow}
            onTimeWindowChange={setChannelWindow}
            sort={channelSort}
            onSortChange={setChannelSort}
            timeMode={channelTimeMode}
            onTimeModeChange={setChannelTimeMode}
            onControlsScrolledAway={setChannelControlsScrolledAway}
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
            ) : feed.groups.length === 0 ? (
              <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
                No videos found.
              </div>
            ) : (
              feed.groups.map((group) => (
                <VideoRow key={group.name} group={group} onChannelClick={selectChannel} />
              ))
            )}
          </div>
        ) : (
          <ChannelsPage selectedTags={selectedTags} onSelectChannel={selectChannel} sort={channelsSort} onSortChange={setChannelsSort} />
        )}
      </main>
    </div>
  )
}