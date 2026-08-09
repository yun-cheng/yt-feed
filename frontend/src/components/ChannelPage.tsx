import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../lib/api'
import type { VideoItem, LabelCount, WatchProgress } from '../App'
import { formatAge } from '../lib/timeWindow'
import type { TimeRange } from '../lib/timeWindow'
import VideoRow from './VideoRow'
import { addChannel, lookupChannel } from '../lib/channels'
import type { ChannelLookup } from '../lib/channels'
import ChannelHeader from './ChannelHeader'
import ChannelTags from './ChannelTags'
import ChannelArchive, { useArchiveStatus } from './ChannelArchive'

type ChannelInfo = {
  youtube_id: string
  title: string
  description: string
  thumbnail_url: string
  subscriber_count: number
  tags: string[]
  suggested_tags: string[]
  // The first scan of a just-added channel is still running, so an empty grid
  // means "not here yet" rather than "nothing matches your filters".
  scanning?: boolean
  // This channel's video-label vocabulary with counts; null = not built yet.
  label_vocab: LabelCount[] | null
  // Whether the channel has any topics at all, independent of the window.
  has_topics: boolean
}

type ChannelResponse = {
  channel: ChannelInfo
  window: string
  sort: string
  videos: VideoItem[]
  total: number
}

type Props = {
  channelId: string
  age: TimeRange
  sort: string
  onSortChange: (s: string) => void
  watchLaterIds?: Set<string>
  onToggleWatchLater?: (video: VideoItem) => void
  onDownload?: (video: VideoItem) => void
  downloadIds?: Set<string>
  onHideChannel?: (channelId: string) => void
  progressById?: Map<string, WatchProgress>
  // Watch statuses to keep; empty = no filter. Applied server-side.
  watchStatuses?: string[]
  shorts?: boolean
  // Selected sidebar label to filter this channel's videos by (null = none).
  labelFilter?: string | null
  // Report the channel's label vocabulary (the sidebar chips) up to App.
  onVocabChange?: (vocab: LabelCount[] | null) => void
  // Report whether phase-1 vocab building is in progress (sidebar spinner).
  onBuildingChange?: (building: boolean) => void
  // Report whether the channel has any topics at all (window-independent).
  onHasTopicsChange?: (has: boolean) => void
}

const CHANNEL_PAGE_SIZE = 60

export default function ChannelPage({ channelId, age, sort, onSortChange, watchLaterIds, onToggleWatchLater, onDownload, downloadIds, onHideChannel, shorts = false, labelFilter = null, onVocabChange, onBuildingChange, onHasTopicsChange, progressById, watchStatuses }: Props) {
  const [channel, setChannel] = useState<ChannelInfo | null>(null)
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  // A channel we don't hold, looked up on YouTube after the 404. Clicking
  // through to one is how you find out it isn't here — an imported video's
  // uploader, a link from anywhere — and "Channel not found" was a dead end
  // when the channel plainly exists and could simply be added.
  const [unknown, setUnknown] = useState<ChannelLookup | null>(null)
  const [addingUnknown, setAddingUnknown] = useState(false)
  const loadingMoreRef = useRef(false)

  // How much of this channel's back catalogue we hold, plus the action that
  // fetches the rest. Polls only while a fill is running.
  const archive = useArchiveStatus(channelId)

  // ── Video labels ──────────────────────────────────────────────
  // vocabReady gates lazy per-video labeling: true once phase-1 built a
  // non-empty vocabulary for this channel.
  const [vocabReady, setVocabReady] = useState(false)
  const labelBuildRef = useRef<string | null>(null)   // channel we've kicked build for
  const pollTimerRef = useRef<number | undefined>(undefined)
  const requestedRef = useRef<Set<string>>(new Set())  // video ids already sent to assign
  const fetchPageRef = useRef<(offset: number, replace: boolean) => Promise<void>>(async () => {})

  // Phase 1: report the vocabulary up to App, and build it (once) if missing.
  const initChannelLabels = useCallback((chan: ChannelInfo) => {
    if (chan.youtube_id !== channelId) return
    onVocabChange?.(chan.label_vocab)
    onHasTopicsChange?.(chan.has_topics)
    if (chan.label_vocab != null) {
      setVocabReady(chan.label_vocab.length > 0)
      return
    }
    if (labelBuildRef.current === channelId) return  // build already in flight
    labelBuildRef.current = channelId
    onBuildingChange?.(true)

    // On completion, refetch page 0 so the vocab arrives with view-scoped counts
    // (the build/status endpoints don't know the current window).
    const finish = () => {
      if (labelBuildRef.current !== channelId) return  // switched away
      onBuildingChange?.(false)
      fetchPageRef.current(0, true)
    }
    const poll = async () => {
      try {
        const s = await (await apiFetch(`/api/channels/${channelId}/labels/status`, { quiet: true })).json()
        if (labelBuildRef.current !== channelId) return
        if (!s.building) { finish(); return }
      } catch { /* keep polling */ }
      pollTimerRef.current = window.setTimeout(poll, 2500)
    }
    apiFetch(`/api/channels/${channelId}/labels/build`, { method: 'POST', quiet: true })
      .then((r) => r.json())
      .then((d) => {
        if (labelBuildRef.current !== channelId) return
        if (d.status === 'ready') { finish(); return }
        pollTimerRef.current = window.setTimeout(poll, 2500)
      })
      .catch(() => { if (labelBuildRef.current === channelId) onBuildingChange?.(false) })
  }, [channelId, onVocabChange, onBuildingChange, onHasTopicsChange])

  // Fetch one page; append unless replacing. The selected label is filtered
  // server-side so it spans the whole channel, not just loaded videos.
  const fetchPage = useCallback(async (offset: number, replace: boolean) => {
    const params = new URLSearchParams({
      age: formatAge(age), sort,
      shorts: String(shorts),
      offset: String(offset), limit: String(CHANNEL_PAGE_SIZE),
    })
    if (labelFilter) params.set('label', labelFilter)
    if (watchStatuses?.length) params.set('watch', watchStatuses.join(','))
    // A 404 here isn't a failure any more — it's how this page finds out the
    // channel isn't one of ours, and it answers by offering to add it. Toasting
    // it as an error would be shouting about the page's own normal path.
    const res = await apiFetch(`/api/channels/${channelId}/videos?${params}`, { quietStatuses: [404] })
    if (!res.ok) throw new Error('Not found')
    const d: ChannelResponse = await res.json()
    setChannel(d.channel)
    setTotal(d.total || 0)
    setVideos((prev) => replace ? (d.videos || []) : [...prev, ...(d.videos || [])])
    if (replace) initChannelLabels(d.channel)
  }, [channelId, age, sort, shorts, labelFilter, watchStatuses, initChannelLabels])
  fetchPageRef.current = fetchPage

  // A finished fill means rows the current query never saw. Refetch page 0 the
  // way a finished label build does, so the list reflects what just arrived
  // instead of waiting for the next navigation.
  const wasFillingRef = useRef(false)
  useEffect(() => {
    const filling = archive.status?.filling ?? false
    if (wasFillingRef.current && !filling) fetchPageRef.current(0, true)
    wasFillingRef.current = filling
  }, [archive.status?.filling])

  // Stop polling and clear per-channel label state when leaving the channel.
  useEffect(() => {
    return () => {
      labelBuildRef.current = null
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      requestedRef.current.clear()
      setVocabReady(false)
    }
  }, [channelId])

  // Phase 2: lazily label the currently-loaded videos that aren't labeled yet.
  useEffect(() => {
    if (!vocabReady) return
    const ids = videos
      .filter((v) => v.title_labels == null && !requestedRef.current.has(v.youtube_id))
      .map((v) => v.youtube_id)
    if (ids.length === 0) return
    ids.forEach((id) => requestedRef.current.add(id))
    let cancelled = false
    apiFetch(`/api/channels/${channelId}/labels/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_ids: ids }),
      quiet: true,
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        const map: Record<string, string[]> = d.labels || {}
        setVideos((prev) => prev.map((v) =>
          ids.includes(v.youtube_id) ? { ...v, title_labels: map[v.youtube_id] ?? [] } : v
        ))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [videos, vocabReady, channelId])

  // Reset to the first page when the channel or filters change.
  useEffect(() => {
    let cancelled = false
    setLoading(true); setNotFound(false); setUnknown(null); setVideos([]); setTotal(0)
    fetchPage(0, true)
      .catch(() => { if (!cancelled) setNotFound(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchPage])

  // We don't hold this channel — ask YouTube who it is, so the page can show
  // the real thing and offer to add it rather than just refusing.
  useEffect(() => {
    if (!notFound) return
    // A channel we don't hold has no videos and so no topics — say so, or the
    // sidebar's Topics section pulses "Loading…" for as long as you're here.
    onVocabChange?.([])
    onBuildingChange?.(false)
    onHasTopicsChange?.(false)
    let cancelled = false
    lookupChannel(channelId).then((info) => { if (!cancelled) setUnknown(info) })
    return () => { cancelled = true }
  }, [notFound, channelId, onVocabChange, onBuildingChange, onHasTopicsChange])

  const addUnknown = useCallback(async () => {
    setAddingUnknown(true)
    let res = null
    try { res = await addChannel(channelId) }
    finally { setAddingUnknown(false) }
    if (!res) return
    // It's one of ours now: drop the not-found state and load the page for real.
    // Its videos are still arriving — the poll below is what brings them in.
    setNotFound(false)
    setUnknown(null)
    setLoading(true)
    fetchPageRef.current(0, true).finally(() => setLoading(false))
  }, [channelId])

  // A channel added moments ago is still being scanned. Refetch until it isn't,
  // so the grid fills itself rather than waiting to be reloaded by hand. The
  // tick is what re-arms the timer: every refetch replaces `channel` with an
  // equal-looking one, so nothing else in the deps would change.
  const [scanTick, setScanTick] = useState(0)
  useEffect(() => {
    if (!channel?.scanning) return
    const t = window.setTimeout(() => {
      fetchPageRef.current(0, true).finally(() => setScanTick((n) => n + 1))
    }, 3000)
    return () => clearTimeout(t)
  }, [channel?.scanning, scanTick])

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || videos.length >= total) return
    loadingMoreRef.current = true
    try { await fetchPage(videos.length, false) }
    catch (e) { console.error('Failed to load more:', e) }
    finally { loadingMoreRef.current = false }
  }, [videos.length, total, fetchPage])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
        Loading...
      </div>
    )
  }

  if (notFound || !channel) {
    // The lookup is still out, or it came back with nothing (a deleted channel,
    // or no network) — which is the only case left with nothing to show.
    if (!unknown) {
      return (
        <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
          Channel not found.
        </div>
      )
    }
    return (
      <div className="px-6 py-4">
        {/* The same header the held channel below gets — this page differs in
            what hangs off it, not in what a channel looks like. */}
        <ChannelHeader
          channel={unknown}
          actions={
            <button
              onClick={addUnknown}
              disabled={addingUnknown}
              className="rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black transition-colors hover:bg-[#ddd] disabled:opacity-40"
            >
              {addingUnknown ? 'Adding…' : 'Add to your feed'}
            </button>
          }
        />
        <p className="text-sm text-[#717171]">
          {addingUnknown
            ? 'Fetching its recent videos…'
            : "You're not following this channel, so there's nothing of theirs here yet. Adding it fetches their recent uploads and keeps them coming."}
        </p>
      </div>
    )
  }

  const ch = channel

  return (
    <div className="px-6 py-4">
      <ChannelHeader
        channel={ch}
        aside={
          <ChannelTags
            channelId={ch.youtube_id}
            tags={ch.tags}
            suggested={ch.suggested_tags ?? []}
            onChange={({ tags, suggested }) =>
              setChannel((c) => (c ? { ...c, tags, suggested_tags: suggested } : c))
            }
          />
        }
      >
        <ChannelArchive status={archive.status} onStart={archive.start} />
      </ChannelHeader>

      {/* Active label filter indicator */}
      {labelFilter && (
        <div className="flex items-center gap-2 mb-4 text-sm text-[#aaa]">
          <span>Filtering by</span>
          <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-white text-black font-medium">
            {labelFilter}
          </span>
          <span className="text-[#555]">· {total} {total === 1 ? 'video' : 'videos'}</span>
        </div>
      )}

      {/* Video grid */}
      {videos.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 h-40 text-[#aaaaaa] text-sm">
          <span>
            {ch.scanning
              // Just added: the grid is empty because its videos are still on
              // their way, which is a different thing from an empty window.
              ? 'Fetching this channel’s recent videos…'
              : labelFilter
                ? `No "${labelFilter}" videos in this time range.`
                : 'No videos in this time range.'}
          </span>
          {/* The moment you want more history is the moment a window comes back
              empty, so the action lives here rather than behind a setting. Only
              offered when there IS more: a channel we hold in full is telling
              you something true. */}
          {!labelFilter && archive.status && !archive.status.exhausted && (
            <span className="flex items-center gap-2 text-xs text-[#777]">
              {archive.status.oldest_held && (
                <span>Fetched back to {new Date(archive.status.oldest_held)
                  .toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}.</span>
              )}
              {archive.status.filling ? (
                <span className="text-[#aaa]">Fetching more…</span>
              ) : (
                <button
                  onClick={archive.start}
                  className="cursor-pointer rounded-full border border-[#3f3f3f] px-2.5 py-0.5 text-[#aaa] transition-colors hover:border-[#666] hover:text-white"
                >
                  Fetch older videos
                  {archive.status.remaining ? ` (${archive.status.remaining.toLocaleString()})` : ''}
                </button>
              )}
            </span>
          )}
        </div>
      ) : (
        <VideoRow
          progressById={progressById}
          group={{ name: ch.title, icon: '', sort_order: 0, videos }}
          onChannelClick={(id) => window.open(`https://www.youtube.com/channel/${id}`, '_blank')}
          sort={sort}
          watchLaterIds={watchLaterIds}
          onToggleWatchLater={onToggleWatchLater}
          onDownload={onDownload}
          downloadIds={downloadIds}
          onHideChannel={onHideChannel}
          totalCount={total}
          onLoadMore={loadMore}
          hasMore={videos.length < total}
        />
      )}
    </div>
  )
}