/** The speeds the player offers, as they're edited on the settings page. */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import SpeedsEditor from '../components/SpeedsEditor'
import { DEFAULT_SPEEDS } from '../lib/playbackSpeeds'

describe('SpeedsEditor', () => {
  const field = () => screen.getByLabelText('Playback speeds')

  it('shows the list you have', () => {
    render(<SpeedsEditor value={[0.5, 1, 2]} onChange={vi.fn()} />)
    expect(field()).toHaveValue('0.5, 1, 2')
  })

  it('saves what you typed, tidied', () => {
    const onChange = vi.fn()
    render(<SpeedsEditor value={DEFAULT_SPEEDS} onChange={onChange} />)
    fireEvent.change(field(), { target: { value: '2, 1, 0.5x, 2' } })
    fireEvent.blur(field())
    expect(onChange).toHaveBeenCalledWith([0.5, 1, 2])
    expect(field()).toHaveValue('0.5, 1, 2')
  })

  it('saves on Enter, without waiting to be left', () => {
    const onChange = vi.fn()
    render(<SpeedsEditor value={DEFAULT_SPEEDS} onChange={onChange} />)
    fireEvent.change(field(), { target: { value: '1, 2' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith([1, 2])
  })

  it('says so rather than saving what it could salvage', () => {
    const onChange = vi.fn()
    render(<SpeedsEditor value={DEFAULT_SPEEDS} onChange={onChange} />)
    fireEvent.change(field(), { target: { value: '1, quick' } })
    fireEvent.blur(field())
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(/Speeds are numbers/)).toBeInTheDocument()
  })

  it('leaves the field as it was on Escape', () => {
    render(<SpeedsEditor value={[1, 2]} onChange={vi.fn()} />)
    fireEvent.change(field(), { target: { value: '9' } })
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(field()).toHaveValue('1, 2')
  })

  it('offers Reset only once there is something to undo', () => {
    const onChange = vi.fn()
    const { rerender } = render(<SpeedsEditor value={DEFAULT_SPEEDS} onChange={onChange} />)
    expect(screen.getByText('Reset')).toBeDisabled()
    rerender(<SpeedsEditor value={[1, 2]} onChange={onChange} />)
    fireEvent.click(screen.getByText('Reset'))
    expect(onChange).toHaveBeenCalledWith(DEFAULT_SPEEDS)
  })
})
