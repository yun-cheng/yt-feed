import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import TimeSortControls, { SORT_OPTIONS, CHANNEL_SORT_OPTIONS } from '../components/TimeSortControls'

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
