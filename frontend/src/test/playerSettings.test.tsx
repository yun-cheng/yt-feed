/**
 * The player's two settings, as they're edited: the list of speeds, and the
 * key each action is on.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import SpeedsEditor from '../components/SpeedsEditor'
import ShortcutsEditor from '../components/ShortcutsEditor'
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

describe('ShortcutsEditor', () => {
  const rowFor = (action: string) => screen.getByLabelText(`Shortcut for ${action}`)

  it('shows the key each action is on', () => {
    render(<ShortcutsEditor value={{}} onChange={vi.fn()} />)
    expect(rowFor('Mute')).toHaveTextContent('M')
    expect(rowFor('Volume up')).toHaveTextContent('↑')
  })

  it('takes the key you press, not the name you type', () => {
    const onChange = vi.fn()
    render(<ShortcutsEditor value={{}} onChange={onChange} />)
    fireEvent.click(rowFor('Mute'))
    expect(rowFor('Mute')).toHaveTextContent('press a key')
    fireEvent.keyDown(document, { key: 'x' })
    expect(onChange).toHaveBeenCalledWith({ mute: 'x' })
  })

  it('refuses a key another action is on, and says which', () => {
    const onChange = vi.fn()
    render(<ShortcutsEditor value={{}} onChange={onChange} />)
    fireEvent.click(rowFor('Mute'))
    fireEvent.keyDown(document, { key: 'f' })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(/Fullscreen is already on that key/)).toBeInTheDocument()
  })

  it('stores a key put back on its default as nothing at all', () => {
    // Otherwise a default that moves later wouldn't move for this person.
    const onChange = vi.fn()
    render(<ShortcutsEditor value={{ mute: 'x' }} onChange={onChange} />)
    fireEvent.click(rowFor('Mute'))
    fireEvent.keyDown(document, { key: 'm' })
    expect(onChange).toHaveBeenCalledWith({})
  })

  it('leaves the row alone on Escape', () => {
    const onChange = vi.fn()
    render(<ShortcutsEditor value={{}} onChange={onChange} />)
    fireEvent.click(rowFor('Mute'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
    expect(rowFor('Mute')).toHaveTextContent('M')
  })

  it('will not take space, which plays and pauses everywhere', () => {
    const onChange = vi.fn()
    render(<ShortcutsEditor value={{}} onChange={onChange} />)
    fireEvent.click(rowFor('Mute'))
    fireEvent.keyDown(document, { key: ' ' })
    fireEvent.keyDown(document, { key: 'Shift' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('takes the key away when asked, and says so with a dash', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ShortcutsEditor value={{}} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('No key for Mute'))
    expect(onChange).toHaveBeenCalledWith({ mute: '' })
    rerender(<ShortcutsEditor value={{ mute: '' }} onChange={onChange} />)
    expect(rowFor('Mute')).toHaveTextContent('—')
    // Nothing left to take away, so the button is gone.
    expect(screen.queryByLabelText('No key for Mute')).not.toBeInTheDocument()
  })

  it('gives an unbound action a key again', () => {
    const onChange = vi.fn()
    render(<ShortcutsEditor value={{ mute: '' }} onChange={onChange} />)
    fireEvent.click(rowFor('Mute'))
    fireEvent.keyDown(document, { key: 'x' })
    expect(onChange).toHaveBeenCalledWith({ mute: 'x' })
  })

  it('puts one row back where it was', () => {
    const onChange = vi.fn()
    render(<ShortcutsEditor value={{ mute: 'x', pin: 'y' }} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Back to M'))
    expect(onChange).toHaveBeenCalledWith({ pin: 'y' })
  })

  it('puts them all back', () => {
    const onChange = vi.fn()
    render(<ShortcutsEditor value={{ mute: 'x' }} onChange={onChange} />)
    fireEvent.click(screen.getByText('Reset'))
    expect(onChange).toHaveBeenCalledWith({})
  })
})
