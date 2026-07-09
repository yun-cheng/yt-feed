import { useState, useEffect, useRef } from 'react'
import VideoCard from './VideoCard'
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

export default function SearchPage({
  query, onChannelClick, sort, watchLaterIds, onToggleWatchLater, onDownload, downloadIds, onHideChannel,
}: Props) {
  const [channels, setChannels] = useState<ChannelHit[]>([])
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [loading, setLoading] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  // Debounce the query so we search as the user pauses, not every keystroke.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setChannels([]); setVideos([]); setLoading(false)
      return
    }
    setLoading(true)
    const ctrl = new AbortController()
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=30`, { signal: ctrl.signal })
        if (res.ok) {
          const data = await res.json()
          setChannels(data.channels || [])
          setVideos(data.videos || [])
        }
      } catch { /* aborted or offline */ } finally {
        setLoading(false)
      }
    }, 150)
    return () => { clearTimeout(id); ctrl.abort() }
  }, [query])

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

          {/* Videos section */}
          {videos.length > 0 && (
            <section className="mb-8">
              <h2 className="text-lg font-semibold text-white mb-4">Videos</h2>
              <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-x-4 gap-y-6">
                {videos.map((video) => (
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
            </section>
          )}
        </>
      )}
    </div>
  )
}
