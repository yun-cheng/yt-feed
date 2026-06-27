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

  it('opens YouTube on card click', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    fireEvent.click(screen.getByRole('img', { name: 'Test Video Title' }).closest('.relative')!)
    expect(window.open).toHaveBeenCalledWith('https://www.youtube.com/watch?v=abc123', '_blank')
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
