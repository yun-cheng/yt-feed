import { useRef, useState, useEffect, useCallback } from 'react'
import VideoCard from './VideoCard'
import type { FeedGroup } from '../App'

const INITIAL_COUNT = 20
const LOAD_MORE = 20

import type { VideoItem } from '../App'

type Props = {
  group: FeedGroup
  onChannelClick: (channelId: string) => void
  sort?: string
  watchLaterIds?: Set<string>
  onToggleWatchLater?: (video: VideoItem) => void
}

export default function VideoRow({ group, onChannelClick, sort, watchLaterIds, onToggleWatchLater }: Props) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_COUNT)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const hasMore = visibleCount < group.videos.length
  const visibleVideos = group.videos.slice(0, visibleCount)

  const loadMore = useCallback(() => {
    if (hasMore) {
      setVisibleCount((prev) => Math.min(prev + LOAD_MORE, group.videos.length))
    }
  }, [hasMore, group.videos.length])

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loadMore])

  return (
    <section className="mb-8">
      {/* Group header */}
      <div className="flex items-center gap-2 mb-4">
        {group.icon && <span className="text-lg">{group.icon}</span>}
        <h2 className="text-lg font-semibold text-white">{group.name}</h2>
        <span className="text-xs text-[#717171] ml-1">
          {group.videos.length} videos
        </span>
      </div>

      {/* Video grid */}
      <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-x-4 gap-y-6">
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
          />
        ))}
      </div>

      {/* Sentinel for infinite scroll */}
      {hasMore && (
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