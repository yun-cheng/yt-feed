import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import ChatOverlay from '../components/ChatOverlay'
import type { ChatMessage, ChatState } from '../components/ChatReplay'
import {
  CHAT_OVERLAY_KEY, MIN_H, MIN_W, OVERLAY_DEFAULTS, clampBox, loadChatOverlay, moveBox, nextBackdrop,
  resizeBox, saveChatOverlay, type ChatOverlayPrefs,
} from '../lib/chatOverlay'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

// ── Where it sits ────────────────────────────────────────────────────

describe('the overlay box', () => {
  it('stays whole and inside the player', () => {
    expect(clampBox({ x: 0.9, y: -0.2, w: 0.3, h: 0.5 })).toEqual({ x: 0.7, y: 0, w: 0.3, h: 0.5 })
    expect(clampBox({ x: 0, y: 0, w: 0.01, h: 2 })).toEqual({ x: 0, y: 0, w: MIN_W, h: 1 })
  })

  it('moves by the drag, stopping at the player’s edges', () => {
    const b = { x: 0.5, y: 0.2, w: 0.3, h: 0.4 }
    expect(moveBox(b, 0.1, 0.1)).toEqual({ x: 0.6, y: 0.30000000000000004, w: 0.3, h: 0.4 })
    expect(moveBox(b, 0.9, -0.9)).toEqual({ x: 0.7, y: 0, w: 0.3, h: 0.4 })
  })

  it('grows from its right corner without passing the player’s edge', () => {
    const b = { x: 0.5, y: 0.2, w: 0.3, h: 0.4 }
    expect(resizeBox(b, 'se', 0.5, 0.1).w).toBeCloseTo(0.5)
    expect(resizeBox(b, 'se', 0.5, 0.1).h).toBeCloseTo(0.5)
    expect(resizeBox(b, 'se', -1, -1)).toEqual({ x: 0.5, y: 0.2, w: MIN_W, h: MIN_H })
  })

  it('grows from its left corner keeping its right edge where it was', () => {
    const b = { x: 0.5, y: 0.2, w: 0.3, h: 0.4 }
    const wider = resizeBox(b, 'sw', -0.2, 0)
    expect(wider.x).toBeCloseTo(0.3)
    expect(wider.x + wider.w).toBeCloseTo(0.8)
    // Dragged past the right edge it stops at the narrowest, still ending at 0.8.
    const narrow = resizeBox(b, 'sw', 0.5, 0)
    expect(narrow.w).toBeCloseTo(MIN_W)
    expect(narrow.x + narrow.w).toBeCloseTo(0.8)
  })

  it('steps the backdrop from none to light to darker and round again', () => {
    expect(nextBackdrop('none')).toBe('light')
    expect(nextBackdrop('light')).toBe('medium')
    expect(nextBackdrop('medium')).toBe('none')
  })

  it('is kept for next time, and survives a store it can’t read', () => {
    expect(loadChatOverlay()).toEqual(OVERLAY_DEFAULTS)
    saveChatOverlay({ on: true, x: 0.1, y: 0.1, w: 0.3, h: 0.3, backdrop: 'none' })
    expect(loadChatOverlay()).toEqual({ on: true, x: 0.1, y: 0.1, w: 0.3, h: 0.3, backdrop: 'none' })
    localStorage.setItem(CHAT_OVERLAY_KEY, JSON.stringify({ on: true, x: 5, w: 'wide', backdrop: 'neon' }))
    const odd = loadChatOverlay()
    expect(odd.on).toBe(true)
    expect(odd.backdrop).toBe(OVERLAY_DEFAULTS.backdrop)
    expect(odd.w).toBe(OVERLAY_DEFAULTS.w)
    expect(odd.x + odd.w).toBeLessThanOrEqual(1)
    localStorage.setItem(CHAT_OVERLAY_KEY, '{oops')
    expect(loadChatOverlay()).toEqual(OVERLAY_DEFAULTS)
  })
})

// ── The overlay ──────────────────────────────────────────────────────

const MESSAGES: ChatMessage[] = [{ t: 5_000, a: '@ann', r: ['hello'] }]
const done: { state: ChatState; retry: () => void } = { state: { status: 'done', messages: MESSAGES }, retry: vi.fn() }

function mount(prefs: Partial<ChatOverlayPrefs> = {}) {
  // The player box: 1000 × 500 on screen.
  const room = { current: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }) } as HTMLElement }
  const onPrefs = vi.fn()
  const onDock = vi.fn()
  const onClose = vi.fn()
  const full = { ...OVERLAY_DEFAULTS, on: true, x: 0.5, y: 0.2, w: 0.3, h: 0.4, ...prefs }
  render(
    <ChatOverlay
      room={room} prefs={full} onPrefs={onPrefs} feed={done} time={10} duration={60}
      onSeek={vi.fn()} syncButton={{ className: '', icon: '↓' }} onDock={onDock} onClose={onClose}
    />,
  )
  return { onPrefs, onDock, onClose, full }
}

function drag(el: Element, dx: number, dy: number) {
  fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 })
  fireEvent.pointerUp(el, { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 })
}

describe('ChatOverlay', () => {
  it('shows the chat without its times, where it was put', () => {
    mount()
    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '0:05' })).not.toBeInTheDocument()
    const box = screen.getByTestId('chat-overlay')
    expect(box.style.left).toBe('50%')
    expect(box.style.width).toBe('30%')
  })

  it('moves when its strip is dragged, and keeps where it was left', () => {
    const { onPrefs, full } = mount()
    drag(screen.getByLabelText('Drag to move'), -100, 50)
    // 100px of a 1000px player left, 50px of a 500px one down.
    expect(onPrefs).toHaveBeenCalledTimes(1)
    const kept = onPrefs.mock.calls[0][0]
    expect(kept.x).toBeCloseTo(0.4)
    expect(kept.y).toBeCloseTo(0.3)
    expect(kept.w).toBe(full.w)
  })

  it('resizes from a corner', () => {
    const { onPrefs } = mount()
    const [sw, se] = screen.getAllByLabelText('Drag to resize')
    drag(se, 100, 50)
    expect(onPrefs.mock.calls[0][0].w).toBeCloseTo(0.4)
    expect(onPrefs.mock.calls[0][0].h).toBeCloseTo(0.5)
    drag(sw, -100, 0)
    expect(onPrefs.mock.calls[1][0].x).toBeCloseTo(0.4)
    expect(onPrefs.mock.calls[1][0].w).toBeCloseTo(0.4)
  })

  it('switches its backdrop, goes back to the panel, and closes', () => {
    const { onPrefs, onDock, onClose } = mount({ backdrop: 'light' })
    fireEvent.click(screen.getByRole('button', { name: 'Light background' }))
    expect(onPrefs.mock.calls[0][0].backdrop).toBe('medium')
    fireEvent.click(screen.getByRole('button', { name: 'Back to the panel' }))
    expect(onDock).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close the chat' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps its clicks from the player under it', () => {
    const onPlayerClick = vi.fn()
    const room = { current: null }
    render(
      <div onClick={onPlayerClick} onPointerDown={onPlayerClick}>
        <ChatOverlay
          room={room} prefs={{ ...OVERLAY_DEFAULTS, on: true }} onPrefs={vi.fn()} feed={done} time={10} duration={60}
          onSeek={vi.fn()} syncButton={{ className: '', icon: '↓' }} onDock={vi.fn()} onClose={vi.fn()}
        />
      </div>,
    )
    fireEvent.pointerDown(screen.getByText('hello'))
    fireEvent.click(screen.getByText('hello'))
    expect(onPlayerClick).not.toHaveBeenCalled()
  })
})
