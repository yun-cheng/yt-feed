import VideoRow from './VideoRow'
import type { VideoItem } from '../App'
import { sortWatchLater } from '../App'

type Props = {
  videos: VideoItem[]
  sort: string
  onChannelClick: (channelId: string) => void
  watchLaterIds: Set<string>
  onToggleWatchLater: (video: VideoItem) => void
  onDownload: (video: VideoItem) => void
  downloadIds: Set<string>
  onRemoveImported: (video: VideoItem) => void
  onImport: () => void
}

export default function ImportedPage({
  videos, sort, onChannelClick, watchLaterIds, onToggleWatchLater,
  onDownload, downloadIds, onRemoveImported, onImport,
}: Props) {
  if (videos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-[#aaa]">
        <svg className="w-12 h-12 text-[#444]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15V3m0 12l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
        </svg>
        <p className="text-sm">No imported videos yet.</p>
        <button onClick={onImport} className="text-xs text-[#3ea6ff] hover:underline">
          Paste a YouTube link to import one
        </button>
      </div>
    )
  }

  // 'added' keeps the server's order (most recently imported first); every other
  // mode is the same client-side sort the Watch Later page uses. No time window
  // here — see IMPORTED_SORT_OPTIONS.
  const ordered = sort === 'added' ? videos : sortWatchLater(videos, sort)

  return (
    <div className="px-6 py-4">
      <VideoRow
        key="imported"
        group={{ name: 'Imported', icon: '', sort_order: 0, videos: ordered }}
        onChannelClick={onChannelClick}
        sort={sort}
        watchLaterIds={watchLaterIds}
        onToggleWatchLater={onToggleWatchLater}
        onDownload={onDownload}
        downloadIds={downloadIds}
        onRemoveImported={onRemoveImported}
      />
    </div>
  )
}
