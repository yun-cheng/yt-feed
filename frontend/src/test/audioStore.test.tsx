/**
 * Shared preview volume. There is deliberately no global MUTE here — previews
 * always start muted and unmuting is per-video — so these only cover volume.
 */
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const KEY = 'yt-feed-audio-v1'

/** The store reads localStorage once at import, so each case needs a fresh one. */
async function load() {
  vi.resetModules()
  return import('../hooks/audioStore')
}

function Harness({ useVolume }: { useVolume: () => number }) {
  return <div data-testid="vol">{useVolume()}</div>
}

beforeEach(() => { localStorage.clear() })

describe('audioStore', () => {
  it('starts at full volume when nothing is stored', async () => {
    const { useVolume } = await load()
    render(<Harness useVolume={useVolume} />)
    expect(screen.getByTestId('vol')).toHaveTextContent('100')
  })

  it('restores the stored volume', async () => {
    localStorage.setItem(KEY, JSON.stringify({ volume: 40 }))
    const { useVolume } = await load()
    render(<Harness useVolume={useVolume} />)
    expect(screen.getByTestId('vol')).toHaveTextContent('40')
  })

  it('persists a change', async () => {
    const { setAudioVolume } = await load()
    act(() => { setAudioVolume(55) })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ volume: 55 })
  })

  it('updates every subscriber, which is the point of sharing it', async () => {
    const { useVolume, setAudioVolume } = await load()
    render(<><Harness useVolume={useVolume} /><Harness useVolume={useVolume} /></>)
    act(() => { setAudioVolume(30) })
    for (const el of screen.getAllByTestId('vol')) expect(el).toHaveTextContent('30')
  })

  it('clamps to 0–100', async () => {
    const { useVolume, setAudioVolume } = await load()
    render(<Harness useVolume={useVolume} />)
    act(() => { setAudioVolume(500) })
    expect(screen.getByTestId('vol')).toHaveTextContent('100')
    act(() => { setAudioVolume(-20) })
    expect(screen.getByTestId('vol')).toHaveTextContent('0')
  })

  it('snaps to the nearest step of 5', async () => {
    // Nothing that moves the volume — a drag, the arrow keys, the embed's own
    // control read back — should be able to leave it on 48.
    const { useVolume, setAudioVolume } = await load()
    render(<Harness useVolume={useVolume} />)
    act(() => { setAudioVolume(48) })
    expect(screen.getByTestId('vol')).toHaveTextContent('50')
    act(() => { setAudioVolume(42.6) })
    expect(screen.getByTestId('vol')).toHaveTextContent('45')
    act(() => { setAudioVolume(2) })
    expect(screen.getByTestId('vol')).toHaveTextContent('0')
  })

  it('snaps a stored value that is off the step', async () => {
    // Whatever earlier versions persisted comes back on the grid.
    localStorage.setItem(KEY, JSON.stringify({ volume: 43 }))
    const { useVolume } = await load()
    render(<Harness useVolume={useVolume} />)
    expect(screen.getByTestId('vol')).toHaveTextContent('45')
  })

  it('ignores a set that changes nothing', async () => {
    const { setAudioVolume } = await load()
    act(() => { setAudioVolume(50) })
    localStorage.removeItem(KEY)
    act(() => { setAudioVolume(50) })  // same value — no write
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('clamps a stored value that is out of range', async () => {
    localStorage.setItem(KEY, JSON.stringify({ volume: 900 }))
    const { useVolume } = await load()
    render(<Harness useVolume={useVolume} />)
    expect(screen.getByTestId('vol')).toHaveTextContent('100')
  })

  it.each(['not json', '{}', '{"volume":"loud"}', 'null'])(
    'falls back to full volume on malformed storage (%s)',
    async (raw) => {
      localStorage.setItem(KEY, raw)
      const { useVolume } = await load()
      render(<Harness useVolume={useVolume} />)
      expect(screen.getByTestId('vol')).toHaveTextContent('100')
    },
  )

  it('follows a change made in another tab', async () => {
    const { useVolume } = await load()
    render(<Harness useVolume={useVolume} />)
    localStorage.setItem(KEY, JSON.stringify({ volume: 25 }))
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
    })
    expect(screen.getByTestId('vol')).toHaveTextContent('25')
  })

  it('ignores storage events for other keys', async () => {
    const { useVolume } = await load()
    render(<Harness useVolume={useVolume} />)
    localStorage.setItem(KEY, JSON.stringify({ volume: 25 }))
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }))
    })
    expect(screen.getByTestId('vol')).toHaveTextContent('100')
  })
})
