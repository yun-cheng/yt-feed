import { useState, useEffect, useRef, useCallback } from 'react'
import VideoCard from './VideoCard'
import type { DownloadItem, VideoItem } from '../App'

type Props = {
  downloads: DownloadItem[]
  onDelete: (videoId: string) => void
  onRetry: (d: DownloadItem) => void
}

// Adapt a download record to the VideoItem shape so we can reuse VideoCard
// (cover, hover preview, controls, menu) exactly like the feed.
function toVideoItem(d: DownloadItem): VideoItem {
  return {
    youtube_id: d.youtube_id,
    title: d.title,
    channel_id: d.channel_id,
    channel_name: d.channel_name,
    thumbnail_url: d.thumbnail_url,
    published_at: d.published_at || d.created_at || '',
    view_count: d.view_count,
    like_count: d.like_count,
    duration_seconds: d.duration_seconds,
    score: d.score,
  }
}

export default function DownloadsPage({ downloads, onDelete, onRetry }: Props) {
  const [playing, setPlaying] = useState<DownloadItem | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  // The whole downloaded file, loaded into memory as a blob URL. Both the hover
  // preview and the player read from this so seeking works entirely offline —
  // no per-jump range fetch that a lost network connection would block.
  const [blobUrls, setBlobUrls] = useState<Record<string, string>>({})
  const fetchingRef = useRef<Set<string>>(new Set())
  const blobUrlsRef = useRef(blobUrls)
  blobUrlsRef.current = blobUrls

  const ensureBlob = useCallback((id: string) => {
    if (blobUrlsRef.current[id] || fetchingRef.current.has(id)) return
    fetchingRef.current.add(id)
    fetch(`/api/downloads/${id}/file`)
      .then((r) => r.blob())
      .then((b) => setBlobUrls((prev) => prev[id] ? prev : { ...prev, [id]: URL.createObjectURL(b) }))
      .catch(() => {})
      .finally(() => fetchingRef.current.delete(id))
  }, [])

  // Fetch the file into memory the moment a card is hovered (for the preview)
  // or opened (for the modal).
  useEffect(() => { if (hoveredId) ensureBlob(hoveredId) }, [hoveredId, ensureBlob])
  useEffect(() => { if (playing) ensureBlob(playing.youtube_id) }, [playing, ensureBlob])

  // Release blob URLs on unmount to free the memory.
  useEffect(() => () => { Object.values(blobUrlsRef.current).forEach(URL.revokeObjectURL) }, [])

  if (downloads.length === 0) {
    return (
      <div className="px-6 py-4">
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-[#aaa]">
          <svg className="w-12 h-12 text-[#444]" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
          </svg>
          <p className="text-sm">No downloads yet.</p>
          <p className="text-xs text-[#555]">Open a video's ⋮ menu and choose “下載” to save it here.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="px-6 py-4">
      <h1 className="text-xl font-semibold text-white mb-4">Downloads</h1>
      <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-x-4 gap-y-6">
        {downloads.map((d) =>
          d.status === 'ready' ? (
            // Reuse the feed card: click plays the local file; menu offers "remove".
            <VideoCard
              key={d.youtube_id}
              video={toVideoItem(d)}
              isHovered={hoveredId === d.youtube_id}
              onHover={setHoveredId}
              onChannelClick={(id) => window.open(`https://www.youtube.com/channel/${id}`, '_blank')}
              onOpen={() => setPlaying(d)}
              onRemoveDownload={() => onDelete(d.youtube_id)}
              localOnly
              localSrc={blobUrls[d.youtube_id]}
            />
          ) : (
            // Still downloading / failed — a lightweight status card (no preview yet).
            <div key={d.youtube_id} className="group">
              <div className="relative aspect-video rounded-xl overflow-hidden bg-[#272727]">
                {d.thumbnail_url && (
                  <img src={d.thumbnail_url.replace('hqdefault', 'mqdefault')} alt={d.title} className="w-full h-full object-cover opacity-50" loading="lazy" />
                )}
                {d.status === 'downloading' ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-white">
                    <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span className="text-xs">下載中…</span>
                  </div>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-white">
                    <span className="text-xs text-red-400">下載失敗</span>
                    <button
                      className="text-xs px-3 py-1 rounded-full bg-white/15 hover:bg-white/25 transition-colors"
                      onClick={() => onRetry(d)}
                    >
                      重試
                    </button>
                  </div>
                )}
              </div>
              <div className="flex gap-3 mt-2">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-medium text-white line-clamp-2 leading-5">{d.title}</h3>
                  <p className="text-xs text-[#aaaaaa] mt-0.5">{d.channel_name || 'Unknown'}</p>
                  <p className="text-xs text-[#717171] mt-0.5">{d.status === 'downloading' ? '下載中…' : '下載失敗'}</p>
                </div>
                <button
                  className="flex-shrink-0 p-1.5 -mr-1 self-start rounded-full text-[#aaa] hover:bg-white/10 hover:text-white transition-colors"
                  onClick={() => onDelete(d.youtube_id)}
                  title="Remove download"
                  aria-label="Remove download"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0v12a1 1 0 001 1h6a1 1 0 001-1V7"/>
                  </svg>
                </button>
              </div>
            </div>
          )
        )}
      </div>

      {/* Player modal — served from the local file (same-origin, so native speed
          controls and browser extensions work). */}
      {playing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPlaying(null)}
        >
          <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
            {blobUrls[playing.youtube_id] ? (
              <video
                src={blobUrls[playing.youtube_id]}
                className="w-full rounded-xl bg-black aspect-video"
                controls
                autoPlay
              />
            ) : (
              <div className="w-full rounded-xl bg-black aspect-video flex flex-col items-center justify-center gap-3 text-white">
                <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span className="text-xs text-[#aaa]">載入中…</span>
              </div>
            )}
            <div className="flex items-center justify-between mt-3">
              <h2 className="text-white text-sm font-medium line-clamp-1">{playing.title}</h2>
              <button
                className="ml-4 flex-shrink-0 text-sm text-[#aaa] hover:text-white transition-colors"
                onClick={() => setPlaying(null)}
              >
                關閉
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
