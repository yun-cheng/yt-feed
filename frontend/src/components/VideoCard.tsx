import type { VideoItem } from '../App'

type Props = {
  video: VideoItem
  isHovered: boolean
  onHover: (id: string | null) => void
  onChannelClick: (channelId: string) => void
  sort?: string
  isWatchLater?: boolean
  onToggleWatchLater?: (video: VideoItem) => void
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

export default function VideoCard({ video, isHovered, onHover, onChannelClick, sort, isWatchLater, onToggleWatchLater }: Props) {
  const thumb = video.thumbnail_url?.replace('hqdefault', 'mqdefault') || ''
  const videoUrl = `https://www.youtube.com/watch?v=${video.youtube_id}`

  return (
    <div
      className="relative cursor-pointer"
      onMouseEnter={() => onHover(video.youtube_id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => window.open(videoUrl, '_blank')}
    >
      {/* Thumbnail area — swaps to video player on hover */}
      <div className="relative aspect-video rounded-xl overflow-hidden bg-[#272727]">
        {/* Thumbnail — hidden while hovered */}
        <div style={{ display: isHovered ? 'none' : 'block' }}>
          <img
            src={thumb}
            alt={video.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </div>

        {/* Player — always in DOM, hidden until hovered */}
        <div
          className="absolute inset-0 overflow-hidden"
          style={{ display: isHovered ? 'block' : 'none', marginBottom: '-80px' }}
        >
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

        {onToggleWatchLater && (isHovered || isWatchLater) && (
          <button
            className={`absolute top-1 right-1 z-20 p-2 rounded-full transition-colors ${
              isWatchLater
                ? 'bg-white/90 text-black hover:bg-white'
                : 'bg-black/60 text-white hover:bg-black/80'
            }`}
            onClick={(e) => { e.stopPropagation(); onToggleWatchLater(video) }}
            title={isWatchLater ? 'Remove from Watch Later' : 'Save to Watch Later'}
          >
            {isWatchLater ? (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
              </svg>
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
              </svg>
            )}
          </button>
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
          <p
            className="text-xs text-[#aaaaaa] mt-0.5 hover:text-blue-400 cursor-pointer transition-colors"
            onClick={(e) => { e.stopPropagation(); onChannelClick(video.channel_id) }}
          >
            {video.channel_name || 'Unknown'}
          </p>
          <p className="text-xs text-[#717171] mt-0.5">
            {(() => {
              const likeRate = video.view_count > 0 ? (video.like_count / video.view_count) * 100 : null
              const stats: { key: string; label: string }[] = [
                { key: 'views', label: formatViewCount(video.view_count) + ' views' },
                { key: 'score', label: video.score.toFixed(1) + ' v/h' },
                { key: 'likes', label: formatViewCount(video.like_count) + ' likes' },
                ...(likeRate !== null ? [{ key: 'like%', label: likeRate.toFixed(1) + '%' }] : []),
                { key: 'newest', label: timeAgo(video.published_at) },
              ]
              return stats.map(({ key, label }, i) => {
                const active = sort === key || (key === 'newest' && sort === 'oldest')
                return (
                  <span key={key}>
                    {i > 0 && <span className="text-[#444]"> · </span>}
                    <span className={active ? 'text-white font-medium' : ''}>
                      {label}
                    </span>
                  </span>
                )
              })
            })()}
          </p>
        </div>
      </div>
    </div>
  )
}