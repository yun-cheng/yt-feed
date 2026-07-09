import { useRef, useState, useEffect, useCallback } from 'react'
import VideoCard from './VideoCard'
import type { FeedGroup, VideoItem } from '../App'

const INITIAL_COUNT = 20
const LOAD_MORE = 20

type Props = {
  group: FeedGroup
  onChannelClick: (channelId: string) => void
  sort?: string
  watchLaterIds?: Set<string>
  onToggleWatchLater?: (video: VideoItem) => void
  onDownload?: (video: VideoItem) => void
  downloadIds?: Set<string>
  onHideChannel?: (channelId: string) => void
  // Server pagination (feed): when onLoadMore is set, this row renders every
  // video it's given and asks the parent to fetch the next page on scroll,
  // instead of paginating an already-loaded array client-side.
  onLoadMore?: () => void
  hasMore?: boolean
  totalCount?: number
}

export default function VideoRow({ group, onChannelClick, sort, watchLaterIds, onToggleWatchLater, onDownload, downloadIds, onHideChannel, onLoadMore, hasMore: hasMoreProp, totalCount }: Props) {
  const serverMode = typeof onLoadMore === 'function'
  const [visibleCount, setVisibleCount] = useState(INITIAL_COUNT)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const canLoadMore = serverMode ? !!hasMoreProp : visibleCount < group.videos.length
  const visibleVideos = serverMode ? group.videos : group.videos.slice(0, visibleCount)

  const loadMore = useCallback(() => {
    if (!canLoadMore) return
    if (serverMode) onLoadMore!()
    else setVisibleCount((prev) => Math.min(prev + LOAD_MORE, group.videos.length))
  }, [canLoadMore, serverMode, onLoadMore, group.videos.length])

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !canLoadMore) return

    // The scroll happens inside a nested overflow container (<main>), so the
    // observer's root must be that container — otherwise it clips the sentinel
    // at its own bottom and the prefetch rootMargin below has no effect.
    let root: HTMLElement | null = el.parentElement
    while (root) {
      const oy = getComputedStyle(root).overflowY
      if ((oy === 'auto' || oy === 'scroll') && root.scrollHeight > root.clientHeight) break
      root = root.parentElement
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore()
        }
      },
      // Prefetch ~3 card rows before the bottom so the next page is usually
      // already loaded by the time you get there — no visible stall.
      { root, rootMargin: '0px 0px 1000px 0px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [canLoadMore, loadMore])

  return (
    <section className="mb-8">
      {/* Group header */}
      <div className="flex items-center gap-2 mb-4">
        {group.icon && <span className="text-lg">{group.icon}</span>}
        <h2 className="text-lg font-semibold text-white">{group.name}</h2>
        <span className="text-xs text-[#717171] ml-1">
          {totalCount ?? group.videos.length} videos
        </span>
      </div>

      {/* Video grid */}
      <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-x-4 gap-y-6">
        {visibleVideos.map((video) => (
          <VideoCard
            key={video.youtube_id}
            video={video}
            isHovered={hoveredId === video.youtube_id}
            onHover={(id) => setHoveredId(id)}
            onChannelClick={onChannelClick}
            sort={sort}
            isWatchLater={watchLaterIds?.has(video.youtube_id)}
            onToggleWatchLater={onToggleWatchLater}
            onDownload={onDownload}
            isDownloaded={downloadIds?.has(video.youtube_id)}
            onHideChannel={onHideChannel}
          />
        ))}
      </div>

      {/* Sentinel for infinite scroll */}
      {canLoadMore && (
        <div ref={sentinelRef} className="flex justify-center py-6 text-sm text-[#717171]">
          <div className="flex items-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Loading more...
          </div>
        </div>
      )}
    </section>
  )
}