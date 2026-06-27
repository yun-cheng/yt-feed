import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import VideoRow from '../components/VideoRow'
import type { FeedGroup, VideoItem } from '../App'

class MockIntersectionObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

beforeAll(() => {
  window.open = vi.fn()
  global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver
})

function makeVideo(id: string): VideoItem {
  return {
    youtube_id: id,
    title: `Video ${id}`,
    channel_id: 'c1',
    channel_name: 'Channel',
    thumbnail_url: '',
    published_at: new Date().toISOString(),
    view_count: 100,
    like_count: 10,
    duration_seconds: 60,
    score: 5,
  }
}

function makeGroup(count: number, overrides: Partial<FeedGroup> = {}): FeedGroup {
  return {
    name: 'Test Group',
    icon: '',
    sort_order: 0,
    videos: Array.from({ length: count }, (_, i) => makeVideo(`v${i}`)),
    ...overrides,
  }
}

describe('VideoRow', () => {
  it('renders group name', () => {
    render(<VideoRow group={makeGroup(1)} onChannelClick={vi.fn()} />)
    expect(screen.getByText('Test Group')).toBeInTheDocument()
  })

  it('renders video count', () => {
    render(<VideoRow group={makeGroup(3)} onChannelClick={vi.fn()} />)
    expect(screen.getByText('3 videos')).toBeInTheDocument()
  })

  it('renders group icon when non-empty', () => {
    render(<VideoRow group={makeGroup(1, { icon: '🎵' })} onChannelClick={vi.fn()} />)
    expect(screen.getByText('🎵')).toBeInTheDocument()
  })

  it('does not render icon span when icon is empty', () => {
    const { container } = render(<VideoRow group={makeGroup(1, { icon: '' })} onChannelClick={vi.fn()} />)
    // header exists but its icon span should be absent
    const header = container.querySelector('h2')!
    expect(header).toBeInTheDocument()
    // icon would appear directly before group name in header text — check it's just the name
    expect(header.textContent).toMatch(/^Test Group/)
  })

  it('renders all video titles when count <= 20', () => {
    render(<VideoRow group={makeGroup(5)} onChannelClick={vi.fn()} />)
    for (let i = 0; i < 5; i++) {
      expect(screen.getByText(`Video v${i}`)).toBeInTheDocument()
    }
  })

  it('renders only first 20 videos initially when count > 20', () => {
    render(<VideoRow group={makeGroup(25)} onChannelClick={vi.fn()} />)
    expect(screen.getByText('Video v0')).toBeInTheDocument()
    expect(screen.getByText('Video v19')).toBeInTheDocument()
    expect(screen.queryByText('Video v20')).not.toBeInTheDocument()
  })

  it('shows loading sentinel when there are more videos', () => {
    render(<VideoRow group={makeGroup(25)} onChannelClick={vi.fn()} />)
    expect(screen.getByText('Loading more...')).toBeInTheDocument()
  })

  it('does not show loading sentinel when all videos visible', () => {
    render(<VideoRow group={makeGroup(5)} onChannelClick={vi.fn()} />)
    expect(screen.queryByText('Loading more...')).not.toBeInTheDocument()
  })

  it('passes sort to VideoCard (active stat highlighted)', () => {
    render(<VideoRow group={makeGroup(1)} onChannelClick={vi.fn()} sort="views" />)
    const viewsStat = screen.getByText(/100 views/)
    expect(viewsStat).toHaveClass('text-white', 'font-medium')
  })

  it('passes isWatchLater=true when video id is in watchLaterIds', () => {
    const ids = new Set(['v0'])
    render(<VideoRow group={makeGroup(1)} onChannelClick={vi.fn()} watchLaterIds={ids} onToggleWatchLater={vi.fn()} />)
    expect(screen.getByTitle('Remove from Watch Later')).toBeInTheDocument()
  })

  it('passes isWatchLater=false when video id is not in watchLaterIds', () => {
    const ids = new Set<string>()
    render(<VideoRow group={makeGroup(1)} onChannelClick={vi.fn()} watchLaterIds={ids} onToggleWatchLater={vi.fn()} />)
    expect(screen.queryByTitle('Remove from Watch Later')).not.toBeInTheDocument()
  })
})
