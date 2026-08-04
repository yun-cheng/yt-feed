import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import VideoCard from '../components/VideoCard'
import type { VideoItem } from '../App'

const mockVideo: VideoItem = {
  youtube_id: 'abc123',
  title: 'Test Video Title',
  channel_id: 'chan1',
  channel_name: 'Test Channel',
  thumbnail_url: 'https://img.youtube.com/vi/abc123/hqdefault.jpg',
  published_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), // 2h ago
  view_count: 1_500_000,
  like_count: 75_000,
  duration_seconds: 1234,
  score: 450.5,
}

beforeAll(() => {
  window.open = vi.fn()
})

describe('VideoCard', () => {
  it('renders video title', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText('Test Video Title')).toBeInTheDocument()
  })

  it('renders channel name', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText('Test Channel')).toBeInTheDocument()
  })

  it('formats view count in millions', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText(/1\.5M views/)).toBeInTheDocument()
  })

  it('formats duration correctly', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    // 1234s = 20:34
    expect(screen.getByText('20:34')).toBeInTheDocument()
  })

  it('shows relative time', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText(/2h ago/)).toBeInTheDocument()
  })

  it('shows score', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText(/450\.5/)).toBeInTheDocument()
  })

  it('shows thumbnail when not hovered', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    const img = screen.getByRole('img', { name: 'Test Video Title' })
    expect(img).toBeVisible()
  })

  it('calls onHover with video id on mouse enter', () => {
    const onHover = vi.fn()
    render(<VideoCard video={mockVideo} isHovered={false} onHover={onHover} onChannelClick={vi.fn()} />)
    fireEvent.mouseEnter(screen.getByRole('img', { name: 'Test Video Title' }).closest('.relative')!)
    expect(onHover).toHaveBeenCalledWith('abc123')
  })

  it('calls onHover with null on mouse leave', () => {
    const onHover = vi.fn()
    render(<VideoCard video={mockVideo} isHovered={false} onHover={onHover} onChannelClick={vi.fn()} />)
    fireEvent.mouseLeave(screen.getByRole('img', { name: 'Test Video Title' }).closest('.relative')!)
    expect(onHover).toHaveBeenCalledWith(null)
  })

  it('opens the in-app watch page on card click', () => {
    // Dispatched as an app-level event rather than threaded as a callback
    // through every feed surface (VideoRow / Channel / Search / Playlist).
    const onWatch = vi.fn()
    window.addEventListener('app:watch', onWatch)
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    fireEvent.click(screen.getByRole('img', { name: 'Test Video Title' }).closest('.relative')!)
    expect(onWatch).toHaveBeenCalled()
    expect((onWatch.mock.calls[0][0] as CustomEvent).detail).toEqual(mockVideo)
    window.removeEventListener('app:watch', onWatch)
  })

  // Two real anchors carry the title: the transparent one over the thumbnail,
  // and the title text itself.
  const overlayLink = () => screen.getAllByRole('link', { name: 'Test Video Title' })[0]

  it('keeps real YouTube anchors so right-click offers "open in new tab"', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    for (const link of screen.getAllByRole('link', { name: 'Test Video Title' })) {
      expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abc123')
    }
  })

  it('currently opens the watch page on a modifier-click as well as the new tab', () => {
    // Pins a known wrong answer so a fix is a deliberate change, not a surprise.
    // The overlay anchor returns early on a modifier-click so the browser opens
    // YouTube natively — but it doesn't stopPropagation, so the click still
    // reaches the card wrapper's onClick and opens the watch overlay too.
    const onWatch = vi.fn()
    window.addEventListener('app:watch', onWatch)
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    fireEvent.click(overlayLink(), { metaKey: true })
    expect(onWatch).toHaveBeenCalled()
    window.removeEventListener('app:watch', onWatch)
  })

  it.fails('should leave a modifier-click to YouTube alone', () => {
    const onWatch = vi.fn()
    window.addEventListener('app:watch', onWatch)
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    fireEvent.click(overlayLink(), { metaKey: true })
    try {
      expect(onWatch).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('app:watch', onWatch)
    }
  })

  it('opens the watch page on a plain click of the thumbnail overlay', () => {
    const onWatch = vi.fn()
    window.addEventListener('app:watch', onWatch)
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    fireEvent.click(overlayLink())
    expect(onWatch).toHaveBeenCalled()
    window.removeEventListener('app:watch', onWatch)
  })

  it('lets a caller override the open behaviour', () => {
    // Downloads and local files open their own player instead of YouTube's.
    const onOpen = vi.fn()
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('img', { name: 'Test Video Title' }).closest('.relative')!)
    expect(onOpen).toHaveBeenCalledWith(mockVideo)
    // …and drops the YouTube anchor entirely, so there's nothing to cmd-click to.
    expect(screen.queryByRole('link', { name: 'Test Video Title' })).not.toBeInTheDocument()
  })

  it('calls onChannelClick when channel name is clicked', () => {
    const onChannelClick = vi.fn()
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={onChannelClick} />)
    fireEvent.click(screen.getByText('Test Channel'))
    expect(onChannelClick).toHaveBeenCalledWith('chan1')
  })

  it('shows "Unknown" when channel_name is absent', () => {
    const video = { ...mockVideo, channel_name: undefined }
    render(<VideoCard video={video} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText('Unknown')).toBeInTheDocument()
  })

  it('hides duration badge when duration is 0', () => {
    const video = { ...mockVideo, duration_seconds: 0 }
    render(<VideoCard video={video} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    // Duration badge shows MM:SS or H:MM:SS — absence of that specific pattern
    expect(screen.queryByText(/^\d+:\d{2}$/)).not.toBeInTheDocument()
  })
})

describe('VideoCard — Watch Later bookmark', () => {
  it('does not show bookmark button without onToggleWatchLater', () => {
    render(<VideoCard video={mockVideo} isHovered={true} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.queryByTitle(/Watch Later/i)).not.toBeInTheDocument()
  })

  it('shows bookmark button when hovered and onToggleWatchLater provided', () => {
    render(<VideoCard video={mockVideo} isHovered={true} onHover={vi.fn()} onChannelClick={vi.fn()} onToggleWatchLater={vi.fn()} />)
    expect(screen.getByTitle('Save to Watch Later')).toBeInTheDocument()
  })

  it('does not show bookmark button when not hovered and not saved', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} onToggleWatchLater={vi.fn()} />)
    expect(screen.queryByTitle(/Watch Later/i)).not.toBeInTheDocument()
  })

  it('shows filled bookmark when isWatchLater=true even when not hovered', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} isWatchLater={true} onToggleWatchLater={vi.fn()} />)
    expect(screen.getByTitle('Remove from Watch Later')).toBeInTheDocument()
  })

  it('calls onToggleWatchLater with the video when bookmark is clicked', () => {
    const onToggleWatchLater = vi.fn()
    render(<VideoCard video={mockVideo} isHovered={true} onHover={vi.fn()} onChannelClick={vi.fn()} onToggleWatchLater={onToggleWatchLater} />)
    fireEvent.click(screen.getByTitle('Save to Watch Later'))
    expect(onToggleWatchLater).toHaveBeenCalledWith(mockVideo)
  })

  it('bookmark click does not open YouTube (stopPropagation)', () => {
    const onOpen = vi.fn()
    window.open = onOpen
    render(<VideoCard video={mockVideo} isHovered={true} onHover={vi.fn()} onChannelClick={vi.fn()} onToggleWatchLater={vi.fn()} />)
    fireEvent.click(screen.getByTitle('Save to Watch Later'))
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('VideoCard — sort highlighting', () => {
  it('highlights the active sort stat', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} sort="views" />)
    expect(screen.getByText('1.5M views')).toHaveClass('text-white', 'font-medium')
  })

  it('does not highlight other stats when sort=views', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} sort="views" />)
    expect(screen.getByText('75.0K likes')).not.toHaveClass('text-white')
  })

  it('highlights newest stat when sort=oldest', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} sort="oldest" />)
    expect(screen.getByText('2h ago')).toHaveClass('text-white', 'font-medium')
  })

  it('does not highlight any stat when no sort prop', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText('1.5M views')).not.toHaveClass('text-white')
  })
})
