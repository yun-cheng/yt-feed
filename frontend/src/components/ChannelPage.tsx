import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../lib/api'
import type { VideoItem, LabelCount, WatchProgress } from '../App'
import { formatAge } from '../lib/timeWindow'
import type { TimeRange } from '../lib/timeWindow'
import VideoRow from './VideoRow'
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

function formatSubs(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

const CHANNEL_PAGE_SIZE = 60

export default function ChannelPage({ channelId, age, sort, onSortChange, watchLaterIds, onToggleWatchLater, onDownload, downloadIds, onHideChannel, shorts = false, labelFilter = null, onVocabChange, onBuildingChange, onHasTopicsChange, progressById, watchStatuses }: Props) {
  const [channel, setChannel] = useState<ChannelInfo | null>(null)
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [descExpanded, setDescExpanded] = useState(false)
  const [descOverflows, setDescOverflows] = useState(false)
  const descRef = useRef<HTMLParagraphElement>(null)
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
    const res = await apiFetch(`/api/channels/${channelId}/videos?${params}`)
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
    setLoading(true); setNotFound(false); setVideos([]); setTotal(0); setDescExpanded(false)
    fetchPage(0, true)
      .catch(() => { if (!cancelled) setNotFound(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchPage])

  // Only offer a Show more/less toggle when the clamped text is actually clipped.
  // Measured off the (initially clamped) element, so it must run before expansion.
  useEffect(() => {
    const el = descRef.current
    if (!el) { setDescOverflows(false); return }
    setDescOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [channel?.description, loading])

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
    return (
      <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
        Channel not found.
      </div>
    )
  }

  const ch = channel

  return (
    <div className="px-6 py-4">
      {/* Channel header */}
      <div className="flex items-start gap-4 mb-6 pb-6 border-b border-[#272727]">
        <img
          src={ch.thumbnail_url}
          alt={ch.title}
          className="w-20 h-20 rounded-full object-cover bg-[#333] flex-shrink-0"
        />
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-white">{ch.title}</h2>
          <p className="text-sm text-[#777] mt-1">
            {formatSubs(ch.subscriber_count)} subscribers
          </p>
          <ChannelTags
            channelId={ch.youtube_id}
            tags={ch.tags}
            suggested={ch.suggested_tags ?? []}
            onChange={({ tags, suggested }) =>
              setChannel((c) => (c ? { ...c, tags, suggested_tags: suggested } : c))
            }
          />
          {ch.description && (
            <div className="max-w-xl">
              <p
                ref={descRef}
                className={`text-xs text-[#555] mt-2 leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] ${descExpanded ? '' : 'line-clamp-2'}`}
              >
                {ch.description}
              </p>
              {(descOverflows || descExpanded) && (
                <button
                  onClick={() => setDescExpanded((v) => !v)}
                  className="mt-1 text-xs font-medium text-[#777] hover:text-[#aaa]"
                >
                  {descExpanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          )}
          <ChannelArchive status={archive.status} onStart={archive.start} />
          <a
            href={`https://www.youtube.com/channel/${ch.youtube_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-2 text-xs text-blue-400 hover:text-blue-300"
          >
            Open on YouTube →
          </a>
        </div>
      </div>


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
            {labelFilter
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