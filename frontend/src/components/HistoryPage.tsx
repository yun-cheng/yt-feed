import VideoRow from './VideoRow'
import type { HistoryItem, VideoItem, WatchProgress } from '../App'
import { sortWatchLater } from '../App'

type Props = {
  // Already filtered by the Videos/Shorts toggle and the sidebar tags.
  history: HistoryItem[]
  // How many rows exist before those filters — tells "nothing watched yet"
  // apart from "nothing matches what you've selected".
  totalCount: number
  sort: string
  progressById: Map<string, WatchProgress>
  onChannelClick: (channelId: string) => void
  watchLaterIds: Set<string>
  onToggleWatchLater: (video: VideoItem) => void
  onDownload: (video: VideoItem) => void
  downloadIds: Set<string>
  onRemoveHistory: (video: VideoItem) => void
}

export default function HistoryPage({
  history, totalCount, sort, progressById, onChannelClick, watchLaterIds,
  onToggleWatchLater, onDownload, downloadIds, onRemoveHistory,
}: Props) {
  if (totalCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-[#aaa]">
        <svg className="w-12 h-12 text-[#444]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-sm">Nothing watched yet.</p>
        <p className="text-xs text-[#555]">Videos show up here once you've played more than a few seconds.</p>
      </div>
    )
  }

  if (history.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-[#717171] text-sm">
        No watched videos match the current filters.
      </div>
    )
  }

  // 'recent' keeps the server's order (most recently watched first); the other
  // modes are the same client-side sort the Watch Later page uses. No time
  // window — when you watched something has nothing to do with when it was
  // published, and filtering by publish date would hide most of the list.
  const ordered = sort === 'recent' ? history : sortWatchLater(history, sort)

  return (
    <div className="px-6 py-4">
      <VideoRow
        key="history"
        group={{ name: 'History', icon: '', sort_order: 0, videos: ordered }}
        onChannelClick={onChannelClick}
        sort={sort}
        watchLaterIds={watchLaterIds}
        onToggleWatchLater={onToggleWatchLater}
        onDownload={onDownload}
        downloadIds={downloadIds}
        progressById={progressById}
        onRemoveHistory={onRemoveHistory}
      />
    </div>
  )
}
