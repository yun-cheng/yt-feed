import { useState } from 'react'
import type { VideoItem } from '../App'

type Props = {
  video: VideoItem
}

function formatViewCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

function formatDuration(s: number): string {
  if (!s || s <= 0) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

function timeAgo(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const hours = Math.floor((now - then) / 3600000)
  if (hours < 1) return 'Just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

export default function VideoCard({ video }: Props) {
  const [hovering, setHovering] = useState(false)

  const thumb = video.thumbnail_url?.replace('hqdefault', 'mqdefault') || ''
  const videoUrl = `https://www.youtube.com/watch?v=${video.youtube_id}`

  return (
    <div
      className="relative cursor-pointer"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={() => window.open(videoUrl, '_blank')}
    >
      {/* Thumbnail area — swaps to video player on hover */}
      <div className="relative aspect-video rounded-xl overflow-hidden bg-[#272727]">
        {hovering ? (
          <div className="absolute inset-0 overflow-hidden" style={{ marginBottom: '-80px' }}>
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${video.youtube_id}?autoplay=1&mute=1&controls=0&rel=0&loop=1&playlist=${video.youtube_id}&iv_load_policy=3&fs=0&disablekb=1&playsinline=1&cc_load_policy=0&modestbranding=1`}
              className="absolute inset-0 w-full"
              style={{ height: 'calc(100% + 80px)', top: '-80px', pointerEvents: 'none' }}
              allow="autoplay; encrypted-media"
              title={video.title}
            />
            {/* Overlay to block mouse events from reaching the iframe */}
            <div className="absolute inset-0 z-10" />
          </div>
        ) : (
          <img
            src={thumb}
            alt={video.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        )}
        {video.duration_seconds > 0 && (
          <div className="absolute bottom-1 right-1 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded font-medium">
            {formatDuration(video.duration_seconds)}
          </div>
        )}
      </div>

      {/* Info row */}
      <div className="flex gap-3 mt-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-white line-clamp-2 leading-5">
            {video.title}
          </h3>
          <p className="text-xs text-[#aaaaaa] mt-0.5">
            {video.channel_name || 'Unknown'}
          </p>
          <p className="text-xs text-[#aaaaaa] mt-0.5">
            {formatViewCount(video.view_count)} views · {timeAgo(video.published_at)}
          </p>
          <div className="text-xs text-[#717171] mt-0.5">
            Score: {video.score.toFixed(1)}
            <span className="text-[#555]"> views/h</span>
          </div>
        </div>
      </div>
    </div>
  )
}