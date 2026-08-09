import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import TopBar from '../components/TopBar'

const defaultProps = {
  variant: 'feed' as const,
  age: { lo: 0, hi: 2 },
  onAgeChange: vi.fn(),
  sort: 'likes',
  onSortChange: vi.fn(),
  onToggleCollapse: vi.fn(),
}

describe('TopBar', () => {
  it('renders time/sort controls for feed variant', () => {
    render(<TopBar {...defaultProps} />)
    expect(screen.getByText('Past 3d')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Likes' })[0]).toBeInTheDocument()
  })

  it('renders channels sort for channels variant', () => {
    render(<TopBar {...defaultProps} variant="channels" sort="subs" age={undefined} />)
    expect(screen.getAllByRole('button', { name: 'Subs' })[0]).toBeInTheDocument()
    expect(screen.queryByTestId('time-thumb-lo')).not.toBeInTheDocument()
  })

  // The four library pages each open on all time and on their own order, so
  // their bar has to carry both halves — the slider and a leading sort named
  // for what that list's order means.
  it.each([
    ['watchlater', 'Saved'],
    ['imported', 'Added'],
    ['downloads', 'Added'],
    ['history', 'Watched'],
  ] as const)('gives %s a window and a "%s" sort', (variant, label) => {
    render(<TopBar {...defaultProps} variant={variant} sort="recent" age={{ lo: 0, hi: 9 }} />)
    expect(screen.getByText('All time')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: label })[0]).toBeInTheDocument()
  })

  // Nothing to order and nothing to window: no second row at all.
  it.each(['search', 'playlists', 'local', 'settings'] as const)('shows no controls on %s', (variant) => {
    render(<TopBar {...defaultProps} variant={variant} />)
    expect(screen.queryByTestId('time-thumb-lo')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Likes' })).not.toBeInTheDocument()
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
    render(<TopBar {...defaultProps} variant="channel" age={{ lo: 0, hi: 5 }} />)
    expect(screen.getByText('Past 1m')).toBeInTheDocument()
  })
})
