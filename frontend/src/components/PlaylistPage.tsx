import { useState, useEffect, useCallback } from 'react'
import VideoRow from './VideoRow'
import type { VideoItem } from '../App'

type Props = {
  playlistId: number
  onChannelClick: (channelId: string) => void
  watchLaterIds?: Set<string>
  onToggleWatchLater?: (video: VideoItem) => void
  onDownload?: (video: VideoItem) => void
  downloadIds?: Set<string>
  onHideChannel?: (channelId: string) => void
  onDeleted: () => void
}

export default function PlaylistPage({
  playlistId, onChannelClick, watchLaterIds, onToggleWatchLater, onDownload, downloadIds, onHideChannel, onDeleted,
}: Props) {
  const [name, setName] = useState('')
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/playlists/${playlistId}`)
      if (!res.ok) { setNotFound(true); return }
      const d = await res.json()
      setName(d.name)
      setVideos(d.videos || [])
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [playlistId])

  useEffect(() => { setLoading(true); setNotFound(false); load() }, [load])

  // Refresh when a video is added/removed from any card's save-to-playlist panel.
  useEffect(() => {
    const h = () => load()
    window.addEventListener('playlists-changed', h)
    return () => window.removeEventListener('playlists-changed', h)
  }, [load])

  const deletePlaylist = async () => {
    try { await fetch(`/api/playlists/${playlistId}`, { method: 'DELETE' }) } catch { /* ignore */ }
    window.dispatchEvent(new Event('playlists-changed'))
    onDeleted()
  }

  const removeFromPlaylist = async (video: VideoItem) => {
    setVideos((prev) => prev.filter((v) => v.youtube_id !== video.youtube_id))  // optimistic
    try {
      await fetch(`/api/playlists/${playlistId}/items/${video.youtube_id}`, { method: 'DELETE' })
    } catch { /* ignore */ }
    window.dispatchEvent(new Event('playlists-changed'))
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-[#aaaaaa]">Loading...</div>
  }
  if (notFound) {
    return <div className="flex items-center justify-center h-64 text-[#aaaaaa]">Playlist not found.</div>
  }

  return (
    <div className="px-6 py-4">
      <div className="flex items-center justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-white truncate">{name}</h2>
          <p className="text-sm text-[#777] mt-1">{videos.length} videos</p>
        </div>
        <button
          onClick={deletePlaylist}
          className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 text-sm text-[#aaa] hover:text-white hover:bg-white/10 rounded-full transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0v12a1 1 0 001 1h6a1 1 0 001-1V7" />
          </svg>
          Delete playlist
        </button>
      </div>

      {videos.length === 0 ? (
        <div className="flex items-center justify-center h-32 text-[#aaaaaa] text-sm">
          This playlist is empty.
        </div>
      ) : (
        <VideoRow
          group={{ name: '', icon: '', sort_order: 0, videos }}
          onChannelClick={onChannelClick}
          watchLaterIds={watchLaterIds}
          onToggleWatchLater={onToggleWatchLater}
          onDownload={onDownload}
          downloadIds={downloadIds}
          onHideChannel={onHideChannel}
          onRemoveFromPlaylist={removeFromPlaylist}
        />
      )}
    </div>
  )
}
