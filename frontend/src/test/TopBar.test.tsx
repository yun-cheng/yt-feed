import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import TopBar from '../components/TopBar'

const defaultProps = {
  variant: 'feed' as const,
  window: '3d',
  onWindowChange: vi.fn(),
  sort: 'likes',
  onSortChange: vi.fn(),
  timeMode: 'wide',
  onTimeModeChange: vi.fn(),
  onToggleCollapse: vi.fn(),
}

describe('TopBar', () => {
  it('renders time/sort controls for feed variant', () => {
    render(<TopBar {...defaultProps} />)
    expect(screen.getAllByRole('button', { name: '3d' })[0]).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Likes' })[0]).toBeInTheDocument()
  })

  it('renders channels sort for channels variant', () => {
    render(<TopBar {...defaultProps} variant="channels" channelsSort="subs" onChannelsSortChange={vi.fn()} />)
    expect(screen.getAllByRole('button', { name: 'Subs' })[0]).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '3d' })).not.toBeInTheDocument()
  })

  it('renders collapse toggle button', () => {
    render(<TopBar {...defaultProps} />)
    expect(screen.getByRole('button', { name: 'Toggle sidebar' })).toBeInTheDocument()
  })

  it('calls onToggleCollapse when collapse button is clicked', () => {
    const onToggleCollapse = vi.fn()
    render(<TopBar {...defaultProps} onToggleCollapse={onToggleCollapse} />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    expect(onToggleCollapse).toHaveBeenCalled()
  })

  it('renders a search box', () => {
    render(<TopBar {...defaultProps} />)
    expect(screen.getByRole('textbox', { name: 'Search' })).toBeInTheDocument()
  })

  it('renders channel variant controls in topbar', () => {
    render(<TopBar {...defaultProps} variant="channel" window="1m" />)
    expect(screen.getAllByRole('button', { name: '1m' })[0]).toBeInTheDocument()
  })
})
