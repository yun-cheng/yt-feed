import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../lib/api'
import VideoRow from './VideoRow'
import type { VideoItem } from '../App'

type ChannelHit = {
  youtube_id: string
  title: string
  thumbnail_url: string
}

type Props = {
  query: string
  onChannelClick: (channelId: string) => void
  sort?: string
  watchLaterIds?: Set<string>
  onToggleWatchLater?: (video: VideoItem) => void
  onDownload?: (video: VideoItem) => void
  downloadIds?: Set<string>
  onHideChannel?: (channelId: string) => void
}

const SEARCH_PAGE_SIZE = 30

export default function SearchPage({
  query, onChannelClick, sort, watchLaterIds, onToggleWatchLater, onDownload, downloadIds, onHideChannel,
}: Props) {
  const [channels, setChannels] = useState<ChannelHit[]>([])
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [videosTotal, setVideosTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const loadingMoreRef = useRef(false)

  // Fetch one page of results; append video hits unless replacing.
  const fetchPage = useCallback(async (q: string, offset: number, replace: boolean, signal?: AbortSignal) => {
    const res = await apiFetch(
      `/api/search?q=${encodeURIComponent(q)}&offset=${offset}&limit=${SEARCH_PAGE_SIZE}`,
      signal ? { signal } : {},
    )
    if (!res.ok) return
    const data = await res.json()
    if (replace) setChannels(data.channels || [])
    setVideosTotal(data.videos_total || 0)
    setVideos((prev) => replace ? (data.videos || []) : [...prev, ...(data.videos || [])])
  }, [])

  // Debounce the query so we search as the user pauses, not every keystroke.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setChannels([]); setVideos([]); setVideosTotal(0); setLoading(false)
      return
    }
    setLoading(true)
    const ctrl = new AbortController()
    const id = setTimeout(async () => {
      try {
        await fetchPage(q, 0, true, ctrl.signal)
      } catch { /* aborted or offline */ } finally {
        setLoading(false)
      }
    }, 150)
    return () => { clearTimeout(id); ctrl.abort() }
  }, [query, fetchPage])

  const loadMore = useCallback(async () => {
    const q = query.trim()
    if (loadingMoreRef.current || !q || videos.length >= videosTotal) return
    loadingMoreRef.current = true
    try { await fetchPage(q, videos.length, false) }
    catch { /* ignore */ } finally { loadingMoreRef.current = false }
  }, [query, videos.length, videosTotal, fetchPage])

  const trimmed = query.trim()

  if (!trimmed) {
    return (
      <div className="px-6 py-16 flex flex-col items-center justify-center text-[#aaa] gap-3">
        <svg className="w-10 h-10 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <p className="text-sm">Search for a channel or video</p>
      </div>
    )
  }

  const empty = !loading && channels.length === 0 && videos.length === 0

  return (
    <div className="px-6 py-4">
      {empty ? (
        <div className="flex flex-col items-center justify-center h-64 gap-2 text-[#aaa]">
          <p className="text-sm">No results for “{trimmed}”</p>
          <p className="text-xs text-[#717171]">Try fewer or different words.</p>
        </div>
      ) : (
        <>
          {/* Channels section */}
          {channels.length > 0 && (
            <section className="mb-8">
              <h2 className="text-lg font-semibold text-white mb-3">Channels</h2>
              <div className="flex flex-col gap-1">
                {channels.map((c) => (
                  <button
                    key={c.youtube_id}
                    onClick={() => onChannelClick(c.youtube_id)}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-[#272727] transition-colors text-left"
                  >
                    {c.thumbnail_url ? (
                      <img src={c.thumbnail_url} alt="" className="w-10 h-10 rounded-full flex-shrink-0 object-cover" />
                    ) : (
                      <div className="w-10 h-10 rounded-full flex-shrink-0 bg-[#272727]" />
                    )}
                    <span className="text-sm text-white truncate">{c.title}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Videos section — paginated (infinite scroll) */}
          {videos.length > 0 && (
            <VideoRow
              group={{ name: 'Videos', icon: '', sort_order: 0, videos }}
              onChannelClick={onChannelClick}
              sort={sort}
              watchLaterIds={watchLaterIds}
              onToggleWatchLater={onToggleWatchLater}
              onDownload={onDownload}
              downloadIds={downloadIds}
              onHideChannel={onHideChannel}
              totalCount={videosTotal}
              onLoadMore={loadMore}
              hasMore={videos.length < videosTotal}
            />
          )}
        </>
      )}
    </div>
  )
}
