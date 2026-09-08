/**
 * The focus-mode preference itself — the store under the button.
 *
 * LocalControls' own suite covers what the bar DOES with it. What's left here
 * is the part that isn't visible from one component: it's a preference, so it
 * survives the page and agrees with the other tabs reading the same key.
 */
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { useFocusMode, setFocusMode } from '../hooks/focusMode'

const KEY = 'yt-feed-focus-mode-v1'

function Harness() {
  return <div data-testid="mode">{useFocusMode() ? 'on' : 'off'}</div>
}

const reading = () => screen.getByTestId('mode').textContent

describe('focus mode', () => {
  // Module state, so localStorage.clear() isn't enough to undo it — one case
  // leaving it on would turn it on for everything after.
  afterEach(() => { setFocusMode(false); localStorage.clear() })

  it('is off until asked for', () => {
    render(<Harness />)
    expect(reading()).toBe('off')
  })

  it('reaches every reader, not just the bar that was clicked', () => {
    render(<Harness />)
    act(() => { setFocusMode(true) })
    expect(reading()).toBe('on')
    act(() => { setFocusMode(false) })
    expect(reading()).toBe('off')
  })

  it('writes the preference down, so the next video opens the way this one did', () => {
    act(() => { setFocusMode(true) })
    expect(localStorage.getItem(KEY)).toBe('1')
  })

  it('takes the other tab’s word for it — same preference, same answer', () => {
    render(<Harness />)
    localStorage.setItem(KEY, '1')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: '1' }))
    })
    expect(reading()).toBe('on')
  })

  it('ignores a storage event about somebody else’s key', () => {
    render(<Harness />)
    act(() => { setFocusMode(true) })
    localStorage.setItem('yt-feed-volume', '50')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'yt-feed-volume', newValue: '50' }))
    })
    expect(reading()).toBe('on')
  })
})
