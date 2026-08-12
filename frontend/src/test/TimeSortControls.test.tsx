import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import TimeSortControls, { SORT_OPTIONS, CHANNEL_SORT_OPTIONS, sortOptionsFor } from '../components/TimeSortControls'

describe('TimeSortControls — feed variant', () => {
  const defaultProps = {
    variant: 'feed' as const,
    age: { lo: 0, hi: 2 },
    onAgeChange: vi.fn(),
    sort: 'likes',
    onSortChange: vi.fn(),
  }

  it('renders the time window slider', () => {
    render(<TimeSortControls {...defaultProps} />)
    expect(screen.getByText('Past 3d')).toBeInTheDocument()
    expect(screen.getByTestId('time-thumb-lo')).toBeInTheDocument()
  })

  it('renders all sort option buttons', () => {
    render(<TimeSortControls {...defaultProps} />)
    for (const opt of SORT_OPTIONS) {
      expect(screen.getByRole('button', { name: opt.label })).toBeInTheDocument()
    }
  })

  it('reports a new range when a tick is clicked', () => {
    const onAgeChange = vi.fn()
    render(<TimeSortControls {...defaultProps} onAgeChange={onAgeChange} />)
    fireEvent.click(screen.getByRole('button', { name: '1w' }))
    expect(onAgeChange).toHaveBeenCalledWith({ lo: 0, hi: 3 })
  })

  it('calls onSortChange when a sort button is clicked', () => {
    const onSortChange = vi.fn()
    render(<TimeSortControls {...defaultProps} onSortChange={onSortChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hot' }))
    expect(onSortChange).toHaveBeenCalledWith('score')
  })

  it('shows the count beside the window when one is given', () => {
    render(<TimeSortControls {...defaultProps} count={1234} />)
    expect(screen.getByText('1,234 videos')).toBeInTheDocument()
  })

  it('leaves the slider out when the page has no window to set', () => {
    render(<TimeSortControls variant="feed" sort="likes" onSortChange={vi.fn()} />)
    expect(screen.queryByTestId('time-thumb-lo')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hot' })).toBeInTheDocument()
  })
})

describe('TimeSortControls — channels variant', () => {
  it('renders channel sort options only', () => {
    render(<TimeSortControls variant="channels" sort="subs" onSortChange={vi.fn()} />)
    for (const opt of CHANNEL_SORT_OPTIONS) {
      expect(screen.getByRole('button', { name: opt.label })).toBeInTheDocument()
    }
    expect(screen.queryByTestId('time-thumb-lo')).not.toBeInTheDocument()
  })

  it('calls onSortChange when A-Z is clicked', () => {
    const onSortChange = vi.fn()
    render(<TimeSortControls variant="channels" sort="subs" onSortChange={onSortChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'A-Z' }))
    expect(onSortChange).toHaveBeenCalledWith('alpha')
  })
})

describe('TimeSortControls — playlist variant', () => {
  const props = {
    variant: 'playlist' as const,
    age: { lo: 0, hi: 6 },
    onAgeChange: vi.fn(),
    sort: 'recent',
    onSortChange: vi.fn(),
  }

  it('offers the library sorts, led by the playlist’s own order', () => {
    render(<TimeSortControls {...props} />)
    // 'Order', not 'Added': an imported playlist keeps YouTube's order, and
    // this is the option that leaves it alone.
    expect(screen.getByRole('button', { name: 'Order' })).toBeInTheDocument()
    for (const opt of SORT_OPTIONS) {
      expect(screen.getByRole('button', { name: opt.label })).toBeInTheDocument()
    }
  })

  it('renders the time window, unlike the playlists grid', () => {
    render(<TimeSortControls {...props} />)
    expect(screen.getByTestId('time-thumb-lo')).toBeInTheDocument()
  })

  it('reports the sort it was asked for', () => {
    const onSortChange = vi.fn()
    render(<TimeSortControls {...props} onSortChange={onSortChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Views' }))
    expect(onSortChange).toHaveBeenCalledWith('views')
  })
})

describe('which pages get a bar at all', () => {
  // `TopBar` is what withholds the bar — it renders nothing when
  // `sortOptionsFor` comes back undefined — so that's the thing to ask.
  it('gives one playlist the library sorts', () => {
    expect(sortOptionsFor('playlist')?.map(o => o.value))
      .toEqual(['recent', ...SORT_OPTIONS.map(o => o.value)])
  })

  it('withholds them from the playlists grid, which lists playlists not videos', () => {
    expect(sortOptionsFor('playlists')).toBeUndefined()
  })

  it('withholds them from search, a local folder and settings', () => {
    for (const page of ['search', 'local', 'localfolder', 'settings']) {
      expect(sortOptionsFor(page)).toBeUndefined()
    }
  })
})
