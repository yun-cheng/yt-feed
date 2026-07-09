import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Sidebar from '../components/Sidebar'
import type { TagInfo } from '../App'

const mockTags: TagInfo[] = [
  { name: 'coding', group: '開發', icon: '💻', channel_count: 5 },
  { name: 'music', group: '音樂', icon: '🎵', channel_count: 3 },
]

const defaultProps = {
  tags: mockTags,
  selectedTags: [],
  onToggleTag: vi.fn(),
  onSetTags: vi.fn(),
  page: 'feed' as const,
  onPageChange: vi.fn(),
  onHome: vi.fn(),
  onToggleCollapse: vi.fn(),
  onClearFilter: vi.fn(),
  collapsed: false,
}

describe('Sidebar — expanded', () => {
  it('renders My Feed and Channels nav buttons', () => {
    render(<Sidebar {...defaultProps} />)
    // Both the sidebar logo and the Home nav item are labelled "My Feed".
    expect(screen.getAllByRole('button', { name: /My Feed/i }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Channels/i })).toBeInTheDocument()
  })

  it('renders tag groups', () => {
    render(<Sidebar {...defaultProps} />)
    expect(screen.getByText('Dev')).toBeInTheDocument()
    expect(screen.getByText('Music')).toBeInTheDocument()
  })

  it('renders tag buttons with counts', () => {
    render(<Sidebar {...defaultProps} />)
    expect(screen.getByText('coding')).toBeInTheDocument()
    expect(screen.getByText('music')).toBeInTheDocument()
  })

  it('calls onToggleTag when a tag is clicked', () => {
    const onToggleTag = vi.fn()
    render(<Sidebar {...defaultProps} onToggleTag={onToggleTag} />)
    fireEvent.click(screen.getByText('coding').closest('button')!)
    expect(onToggleTag).toHaveBeenCalledWith('coding')
  })

  it('calls onPageChange when Channels is clicked', () => {
    const onPageChange = vi.fn()
    render(<Sidebar {...defaultProps} onPageChange={onPageChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Channels/i }))
    expect(onPageChange).toHaveBeenCalledWith('channels')
  })

  it('highlights active page in nav', () => {
    render(<Sidebar {...defaultProps} page="channels" />)
    const channelsBtn = screen.getByRole('button', { name: /Channels/i })
    expect(channelsBtn.className).toMatch(/bg-\[#272727\]/)
  })

  it('shows selected tags with active style', () => {
    render(<Sidebar {...defaultProps} selectedTags={['coding']} />)
    const codingBtn = screen.getByText('coding').closest('button')!
    expect(codingBtn.className).toMatch(/bg-white/)
  })
})

describe('Sidebar — collapsed', () => {
  it('renders icon + label for nav buttons', () => {
    render(<Sidebar {...defaultProps} collapsed={true} />)
    expect(screen.getByText('My Feed')).toBeInTheDocument()
    expect(screen.getByText('Channels')).toBeInTheDocument()
  })

  it('calls onPageChange when My Feed is clicked in collapsed state', () => {
    const onPageChange = vi.fn()
    render(<Sidebar {...defaultProps} collapsed={true} onPageChange={onPageChange} />)
    fireEvent.click(screen.getByText('My Feed').closest('button')!)
    expect(onPageChange).toHaveBeenCalledWith('feed')
  })
})

describe('Sidebar — Watch Later', () => {
  it('renders Watch Later nav button in expanded mode', () => {
    render(<Sidebar {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Watch Later/i })).toBeInTheDocument()
  })

  it('calls onPageChange with watchlater when clicked', () => {
    const onPageChange = vi.fn()
    render(<Sidebar {...defaultProps} onPageChange={onPageChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Watch Later/i }))
    expect(onPageChange).toHaveBeenCalledWith('watchlater')
  })

  it('shows watchLaterCount badge when count > 0', () => {
    render(<Sidebar {...defaultProps} watchLaterCount={7} />)
    // badge shows the count next to the Watch Later button
    const btn = screen.getByRole('button', { name: /Watch Later/i })
    expect(btn).toHaveTextContent('7')
  })

  it('shows 9+ badge in collapsed mode when count > 9', () => {
    render(<Sidebar {...defaultProps} collapsed={true} watchLaterCount={12} />)
    expect(screen.getByText('9+')).toBeInTheDocument()
  })

  it('highlights Watch Later button when page=watchlater', () => {
    render(<Sidebar {...defaultProps} page="watchlater" />)
    const btn = screen.getByRole('button', { name: /Watch Later/i })
    expect(btn.className).toMatch(/bg-\[#272727\]/)
  })

  it('renders Watch Later button in collapsed mode as "Later"', () => {
    render(<Sidebar {...defaultProps} collapsed={true} />)
    expect(screen.getByText('Later')).toBeInTheDocument()
  })
})
