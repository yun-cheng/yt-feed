import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch } from '../lib/api'
import VideoRow from './VideoRow'
import { filterByTime, filterByWatchStatus, sortVideos } from '../App'
import type { VideoItem, WatchProgress } from '../App'
import type { TimeRange } from '../lib/timeWindow'

type Props = {
  playlistId: number
  onChannelClick: (channelId: string) => void
  watchLaterIds?: Set<string>
  onToggleWatchLater?: (video: VideoItem) => void
  onDownload?: (video: VideoItem) => void
  downloadIds?: Set<string>
  onHideChannel?: (channelId: string) => void
  progressById?: Map<string, WatchProgress>
  onDeleted: () => void
  // The top bar's controls, same three as every other library page.
  age?: TimeRange
  sort?: string
  watchStatuses?: string[]
}

export default function PlaylistPage({
  playlistId, onChannelClick, watchLaterIds, onToggleWatchLater, onDownload, downloadIds, onHideChannel, onDeleted, progressById,
  age, sort = 'recent', watchStatuses = [],
}: Props) {
  const [name, setName] = useState('')
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  // Set when this playlist was imported from YouTube — what the re-sync button
  // hangs off. A playlist made here has nothing to pull from.
  const [linked, setLinked] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncNote, setSyncNote] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/playlists/${playlistId}`)
      if (!res.ok) { setNotFound(true); return }
      const d = await res.json()
      setName(d.name)
      setVideos(d.videos || [])
      setLinked(d.youtube_id || '')
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
    try { await apiFetch(`/api/playlists/${playlistId}`, { method: 'DELETE' }) } catch { /* ignore */ }
    window.dispatchEvent(new Event('playlists-changed'))
    onDeleted()
  }

  /** Pull anything new from the YouTube playlist this was imported from. */
  const resync = async () => {
    if (syncing) return
    setSyncing(true)
    setSyncNote('')
    try {
      const res = await apiFetch(`/api/playlists/${playlistId}/resync`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setSyncNote(body.detail || 'Re-sync failed.'); return }
      setSyncNote(body.added ? `Added ${body.added}` : 'Already up to date')
      if (body.added) { await load(); window.dispatchEvent(new Event('playlists-changed')) }
    } catch {
      setSyncNote('Could not reach the app.')
    } finally {
      setSyncing(false)
    }
  }

  /* Windowed by PUBLISH date — the one library page that is, and the exception
   * is worth stating because the rule is a good one everywhere else.
   *
   * Watch Later, Imported, Downloads and History window by when a row joined
   * the list, because you add to those over months and "what did I save this
   * week" is a real question. A playlist isn't that shape. An imported one has
   * every row stamped within the same second — the import — so windowing by
   * that axis can only ever answer "all" or "none", which is not a filter.
   *
   * A playlist is closer to a channel page: a body of videos spanning years,
   * where "the ones from this year" is the question worth asking. That also
   * puts it in step with the Newest / Oldest sorts sitting beside it, which
   * order by the very same date. */
  const shown = useMemo(() => {
    let result = age ? filterByTime(videos, age, v => v.published_at) : videos
    if (progressById) result = filterByWatchStatus(result, watchStatuses, progressById)
    return sortVideos(result, sort)
  }, [videos, age, sort, watchStatuses, progressById])

  const removeFromPlaylist = async (video: VideoItem) => {
    setVideos((prev) => prev.filter((v) => v.youtube_id !== video.youtube_id))  // optimistic
    try {
      await apiFetch(`/api/playlists/${playlistId}/items/${video.youtube_id}`, { method: 'DELETE' })
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
          {/* Only says anything when there IS something to say. The list below
              carries its own count, so repeating it here unfiltered would be
              the same number twice; both numbers appear only when a filter is
              hiding some, so a short list is never mistaken for a short
              playlist. */}
          <p className="text-sm text-[#777] mt-1">
            {shown.length < videos.length && `${shown.length} of ${videos.length} videos`}
            {syncNote && <span className="ml-2 text-[#3ea6ff]">{syncNote}</span>}
          </p>
        </div>
        {linked && (
          <button
            onClick={resync}
            disabled={syncing}
            title="Pull anything new from the YouTube playlist this came from"
            className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 text-sm text-[#aaa] hover:text-white hover:bg-white/10 rounded-full transition-colors disabled:opacity-40"
          >
            <svg className={`w-4 h-4${syncing ? ' animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 11a8 8 0 1 0-.6 4M20 4v6h-6" />
            </svg>
            {syncing ? 'Syncing…' : 'Re-sync'}
          </button>
        )}
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
      ) : shown.length === 0 ? (
        <div className="flex items-center justify-center h-32 text-[#717171] text-sm">
          No videos in this playlist match the current filters.
        </div>
      ) : (
        <VideoRow
          progressById={progressById}
          group={{ name: '', icon: '', sort_order: 0, videos: shown }}
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
