import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import TimeRangeSlider from '../components/TimeRangeSlider'
import { TICK_LABELS } from '../lib/timeWindow'

const setup = (value = { lo: 0, hi: 2 }, onChange = vi.fn()) => {
  render(<TimeRangeSlider value={value} onChange={onChange} />)
  return onChange
}

describe('TimeRangeSlider', () => {
  it('names the range it is showing', () => {
    setup({ lo: 2, hi: 4 })
    expect(screen.getByText('3d–2w ago')).toBeInTheDocument()
  })

  it('puts both edges on the track', () => {
    setup({ lo: 1, hi: 5 })
    expect(screen.getByTestId('time-thumb-lo')).toHaveAttribute('aria-valuetext', '1d')
    expect(screen.getByTestId('time-thumb-hi')).toHaveAttribute('aria-valuetext', '1m')
  })

  it('labels every tick', () => {
    setup()
    for (const label of TICK_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('notches the track at every tick but its two ends', () => {
    setup()
    const notches = screen.getAllByTestId('time-tick')
    expect(notches).toHaveLength(TICK_LABELS.length - 2)
    // Each notch sits where its label does, so the ladder reads as one thing.
    // (Read as numbers: jsdom rewrites '12.50%' to '12.5%'.)
    expect(notches.map(n => parseFloat(n.style.left))).toEqual(
      TICK_LABELS.slice(1, -1).map((_, i) => ((i + 1) / (TICK_LABELS.length - 1)) * 100),
    )
  })

  // 'now' is the origin of the track, never an older edge — so it isn't a target.
  it('offers every tick but the origin as a click target', () => {
    setup()
    expect(screen.getByText('now').tagName).toBe('SPAN')
    expect(screen.getByText('1y').tagName).toBe('BUTTON')
  })

  it('keeps the recent edge when a tick further out is clicked', () => {
    const onChange = setup({ lo: 2, hi: 4 })
    fireEvent.click(screen.getByText('6m'))
    expect(onChange).toHaveBeenCalledWith({ lo: 2, hi: 7 })
  })

  it('falls back to the full span when the tick clicked is inside the range', () => {
    const onChange = setup({ lo: 3, hi: 6 })
    fireEvent.click(screen.getByText('1d'))
    expect(onChange).toHaveBeenCalledWith({ lo: 0, hi: 1 })
  })

  it('drives the thumbs from the keyboard', () => {
    const onChange = setup({ lo: 0, hi: 2 })
    const hi = screen.getByTestId('time-thumb-hi')
    hi.focus()
    fireEvent.keyDown(hi, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith({ lo: 0, hi: 3 })
  })

  it('will not let the keyboard collapse the band to nothing', () => {
    const onChange = setup({ lo: 1, hi: 2 })
    const hi = screen.getByTestId('time-thumb-hi')
    hi.focus()
    fireEvent.keyDown(hi, { key: 'ArrowLeft' })
    // Radix stops the thumb a step short; nothing zero-width ever escapes.
    for (const call of onChange.mock.calls) {
      expect(call[0].hi).toBeGreaterThan(call[0].lo)
    }
  })

  it('shows the count when given one', () => {
    render(<TimeRangeSlider value={{ lo: 0, hi: 2 }} onChange={vi.fn()} count={0} />)
    expect(screen.getByText('0 videos')).toBeInTheDocument()
  })
})
