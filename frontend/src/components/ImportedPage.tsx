import VideoRow from './VideoRow'
import type { VideoItem, WatchProgress } from '../App'
import { sortVideos } from '../App'
import { t } from '../lib/i18n'

type Props = {
  // Already filtered by the time window and the sidebar's watch status.
  videos: VideoItem[]
  // How many are imported before that filter — tells "nothing imported yet"
  // apart from "nothing matches what you've selected".
  totalCount: number
  // The search confined to this page ("In imported"), already applied to
  // `videos`; here only to say why the list came back empty.
  query?: string
  sort: string
  onChannelClick: (channelId: string) => void
  watchLaterIds: Set<string>
  onToggleWatchLater: (video: VideoItem) => void
  onDownload: (video: VideoItem) => void
  downloadIds: Set<string>
  onRemoveImported: (video: VideoItem) => void
  progressById?: Map<string, WatchProgress>
  onImport: () => void
}

export default function ImportedPage({
  videos, totalCount, sort, onChannelClick, watchLaterIds, onToggleWatchLater,
  onDownload, downloadIds, onRemoveImported, onImport, progressById, query = '',
}: Props) {
  if (totalCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-[#aaa]">
        <svg className="w-12 h-12 text-[#444]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15V3m0 12l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
        </svg>
        <p className="text-sm">{t('No imported videos yet.')}</p>
        <button onClick={onImport} className="text-xs text-[#3ea6ff] hover:underline">
          {t('Paste a YouTube link to import one')}
        </button>
      </div>
    )
  }

  if (videos.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-[#717171] text-sm">
        {query.trim()
          ? t('Nothing imported matches “{q}” with the current filters.', { q: query.trim() })
          : t('No imported videos match the current filters.')}
      </div>
    )
  }

  // 'recent' keeps the server's order — most recently imported first, the same
  // axis the time window filters on (see `filterByTime`).
  const ordered = sortVideos(videos, sort)

  return (
    <div className="px-6 py-4">
      <VideoRow
        key="imported"
        group={{ name: t('Imported'), icon: '', sort_order: 0, videos: ordered }}
        onChannelClick={onChannelClick}
        sort={sort}
        watchLaterIds={watchLaterIds}
        onToggleWatchLater={onToggleWatchLater}
        onDownload={onDownload}
        downloadIds={downloadIds}
        onRemoveImported={onRemoveImported}
        progressById={progressById}
      />
    </div>
  )
}
