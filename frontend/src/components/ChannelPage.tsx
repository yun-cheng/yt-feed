import { useState, useEffect, useCallback, useRef } from 'react'
import TimeSortControls from './TimeSortControls'
import type { VideoItem, LabelCount } from '../App'
import VideoRow from './VideoRow'
import ChannelTags from './ChannelTags'

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
  timeWindow: string
  onTimeWindowChange: (w: string) => void
  sort: string
  onSortChange: (s: string) => void
  timeMode: string
  onTimeModeChange: (m: string) => void
  watchLaterIds?: Set<string>
  onToggleWatchLater?: (video: VideoItem) => void
  onDownload?: (video: VideoItem) => void
  downloadIds?: Set<string>
  onHideChannel?: (channelId: string) => void
  shorts?: boolean
  // Selected sidebar label to filter this channel's videos by (null = none).
  labelFilter?: string | null
  // Report the channel's label vocabulary (the sidebar chips) up to App.
  onVocabChange?: (vocab: LabelCount[] | null) => void
  // Report whether phase-1 vocab building is in progress (sidebar spinner).
  onBuildingChange?: (building: boolean) => void
  // Report build progress ({done,total}) while labeling, or null when idle.
  onBuildProgress?: (progress: { done: number; total: number } | null) => void
  // Report whether the channel has any topics at all (window-independent).
  onHasTopicsChange?: (has: boolean) => void
}

function formatSubs(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

const CHANNEL_PAGE_SIZE = 60

export default function ChannelPage({ channelId, timeWindow, onTimeWindowChange, sort, onSortChange, timeMode, onTimeModeChange, watchLaterIds, onToggleWatchLater, onDownload, downloadIds, onHideChannel, shorts = false, labelFilter = null, onVocabChange, onBuildingChange, onBuildProgress, onHasTopicsChange }: Props) {
  const [channel, setChannel] = useState<ChannelInfo | null>(null)
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [descExpanded, setDescExpanded] = useState(false)
  const [descOverflows, setDescOverflows] = useState(false)
  const descRef = useRef<HTMLParagraphElement>(null)
  const loadingMoreRef = useRef(false)

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
      onBuildProgress?.(null)
      fetchPageRef.current(0, true)
    }
    const poll = async () => {
      try {
        const s = await (await fetch(`/api/channels/${channelId}/labels/status`)).json()
        if (labelBuildRef.current !== channelId) return
        onBuildProgress?.(s.progress ?? null)
        if (!s.building) { finish(); return }
      } catch { /* keep polling */ }
      pollTimerRef.current = window.setTimeout(poll, 2500)
    }
    fetch(`/api/channels/${channelId}/labels/build`, { method: 'POST' })
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
      window: timeWindow, sort, time_mode: timeMode,
      shorts: String(shorts),
      offset: String(offset), limit: String(CHANNEL_PAGE_SIZE),
    })
    if (labelFilter) params.set('label', labelFilter)
    const res = await fetch(`/api/channels/${channelId}/videos?${params}`)
    if (!res.ok) throw new Error('Not found')
    const d: ChannelResponse = await res.json()
    setChannel(d.channel)
    setTotal(d.total || 0)
    setVideos((prev) => replace ? (d.videos || []) : [...prev, ...(d.videos || [])])
    if (replace) initChannelLabels(d.channel)
  }, [channelId, timeWindow, sort, timeMode, shorts, labelFilter, initChannelLabels])
  fetchPageRef.current = fetchPage

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
    fetch(`/api/channels/${channelId}/labels/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_ids: ids }),
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
        <div className="flex items-center justify-center h-32 text-[#aaaaaa] text-sm">
          {labelFilter
            ? `No "${labelFilter}" videos in this time range.`
            : 'No videos in this time range.'}
        </div>
      ) : (
        <VideoRow
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