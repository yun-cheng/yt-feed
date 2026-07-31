import { useEffect, useRef, useState } from 'react'
import { formatTime } from '../lib/time'
import { formatSize, watchedRatio } from '../lib/local'
import type { LocalFolder, LocalVideo } from '../lib/local'

type Props = {
  folder: LocalFolder | null
  videos: LocalVideo[]
  // The backend is still measuring durations — see FolderVideos.scanning.
  scanning: boolean
  loading: boolean
  onBack: () => void
  onRescan: () => void
  onOpen: (video: LocalVideo) => void
}

/** One folder's videos, as a grid of cards.
 *
 * Deliberately its own card rather than VideoCard: that one is built around a
 * channel, view counts and a YouTube hover preview, none of which a file on disk
 * has. What it does keep is the shape — thumbnail, duration badge, resume bar,
 * play-on-hover — so the two feeds feel like the same app.
 */
export default function LocalFolderPage({ folder, videos, scanning, loading, onBack, onRescan, onOpen }: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  return (
    <div className="px-6 py-4">
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={onBack}
          className="rounded-full p-1.5 text-[#aaa] transition-colors hover:bg-[#272727] hover:text-white"
          title="All local folders"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-white">{folder?.name ?? 'Local folder'}</h2>
          <p className="truncate text-xs text-[#717171]" title={folder?.path}>{folder?.path}</p>
        </div>
        <span className="flex-shrink-0 text-xs text-[#717171]">{videos.length} videos</span>
        <button
          onClick={onRescan}
          className="flex-shrink-0 rounded-full border border-[#303030] px-3 py-1.5 text-xs text-[#aaa] transition-colors hover:bg-[#272727] hover:text-white"
        >
          Rescan
        </button>
      </div>

      {folder && !folder.available && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          This folder isn't readable right now — the drive may be disconnected. Its videos are listed from the last scan.
        </div>
      )}
      {scanning && (
        <div className="mb-4 flex items-center gap-2 text-xs text-[#717171]">
          <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Reading durations…
        </div>
      )}

      {loading && videos.length === 0 ? (
        <div className="flex h-64 items-center justify-center text-[#aaa]">Scanning folder…</div>
      ) : videos.length === 0 ? (
        <div className="flex h-64 items-center justify-center text-[#aaa]">No videos in this folder.</div>
      ) : (
        <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(360px,1fr))]">
          {videos.map((v) => (
            <LocalVideoCard
              key={v.id}
              video={v}
              hovered={hoveredId === v.id}
              onHover={setHoveredId}
              // Drop the hover preview on the way out: the overlay covers the
              // grid, and a preview left running behind it holds a second
              // stream of the very file the player is about to read.
              onOpen={() => { setHoveredId(null); onOpen(v) }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function LocalVideoCard({ video, hovered, onHover, onOpen }: {
  video: LocalVideo
  hovered: boolean
  onHover: (id: string | null) => void
  onOpen: () => void
}) {
  // The preview only MOUNTS after a beat of hovering: each one is a real range
  // request against the file (which may be streaming down from a cloud drive),
  // so sweeping the cursor across the grid mustn't start twenty of them.
  const [preview, setPreview] = useState(false)
  const [thumbFailed, setThumbFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!hovered) {
      if (timerRef.current) clearTimeout(timerRef.current)
      setPreview(false)
      return
    }
    timerRef.current = setTimeout(() => setPreview(true), 400)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [hovered])

  const ratio = watchedRatio(video)

  return (
    <div
      className="group cursor-pointer"
      onMouseEnter={() => onHover(video.id)}
      onMouseLeave={() => onHover(null)}
      onClick={onOpen}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-[#1c1c1c]">
        {thumbFailed ? (
          <div className="flex h-full w-full items-center justify-center text-[#3f3f3f]">
            <svg className="h-10 w-10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          </div>
        ) : (
          <img
            src={video.thumbnail_url}
            alt=""
            loading="lazy"
            onError={() => setThumbFailed(true)}
            className="h-full w-full object-cover"
          />
        )}

        {preview && (
          <video
            ref={videoRef}
            src={video.file_url}
            muted
            autoPlay
            playsInline
            // Previews are always muted (browsers only autoplay muted video), so
            // there's no volume to share here — a click opens the real player.
            className="absolute inset-0 h-full w-full bg-black object-contain"
          />
        )}

        {video.probed && video.duration_seconds > 0 && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1 py-0.5 text-[11px] font-medium text-white">
            {formatTime(video.duration_seconds)}
          </span>
        )}
        {video.watched && (
          <span className="absolute left-1.5 top-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-medium text-white">
            Watched
          </span>
        )}
        {ratio > 0 && !video.watched && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
            <div className="h-full bg-red-600" style={{ width: `${ratio * 100}%` }} />
          </div>
        )}
      </div>

      <div className="mt-2">
        <h3 className="line-clamp-2 text-sm font-medium leading-5 text-white group-hover:text-[#3ea6ff]">
          {video.title}
        </h3>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-[#717171]">
          {video.sub_dir && (
            <>
              <span className="truncate" title={video.sub_dir}>{video.sub_dir}</span>
              <span>·</span>
            </>
          )}
          <span>{formatSize(video.filesize)}</span>
          {!video.probed && <span className="text-[#555]">· measuring…</span>}
        </div>
      </div>
    </div>
  )
}
