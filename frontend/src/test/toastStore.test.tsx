import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pushToast, pushUndo, dismissToast, runUndo, useToasts, UNDO_MS } from '../hooks/toastStore'
import Toaster from '../components/Toaster'

function Harness() {
  const toasts = useToasts()
  return <div data-testid="count">{toasts.length}</div>
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  // Drain anything still queued so one test's toasts can't outlive it — the
  // store is module-level and shared across every test in the file.
  act(() => { vi.runAllTimers() })
  vi.useRealTimers()
})

describe('toastStore', () => {
  it('pushes a toast that subscribers see', () => {
    render(<Harness />)
    expect(screen.getByTestId('count')).toHaveTextContent('0')
    act(() => { pushToast('boom') })
    expect(screen.getByTestId('count')).toHaveTextContent('1')
  })

  it('gives every toast a distinct id', () => {
    let a = 0, b = 0
    act(() => { a = pushToast('one'); b = pushToast('two') })
    expect(a).not.toBe(b)
  })

  it('keeps several toasts at once, in the order they arrived', () => {
    render(<Toaster />)
    act(() => { pushToast('first'); pushToast('second') })
    const messages = screen.getAllByRole('button').map((b) => b.textContent)
    expect(messages[0]).toContain('first')
    expect(messages[1]).toContain('second')
  })

  it('auto-dismisses after long enough to read', () => {
    render(<Harness />)
    act(() => { pushToast('boom') })
    act(() => { vi.advanceTimersByTime(14_000) })
    expect(screen.getByTestId('count')).toHaveTextContent('1')
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByTestId('count')).toHaveTextContent('0')
  })

  it('dismisses only the toast asked for', () => {
    render(<Harness />)
    let first = 0
    act(() => { first = pushToast('one'); pushToast('two') })
    act(() => { dismissToast(first) })
    expect(screen.getByTestId('count')).toHaveTextContent('1')
  })

  it('dismissing an already-gone toast is a no-op', () => {
    // The auto-dismiss timer still fires after a click-dismiss.
    render(<Harness />)
    let id = 0
    act(() => { id = pushToast('one') })
    act(() => { dismissToast(id); dismissToast(id) })
    expect(screen.getByTestId('count')).toHaveTextContent('0')
  })

  it('stops notifying a component once it unmounts', () => {
    const { unmount } = render(<Harness />)
    unmount()
    expect(() => act(() => { pushToast('boom') })).not.toThrow()
  })
})

describe('Toaster', () => {
  it('renders nothing when there is nothing to say', () => {
    const { container } = render(<Toaster />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the message', () => {
    render(<Toaster />)
    act(() => { pushToast('GET /api/thing failed (500)') })
    expect(screen.getByText(/GET \/api\/thing failed \(500\)/)).toBeInTheDocument()
  })

  it('is click-dismissable', () => {
    render(<Toaster />)
    act(() => { pushToast('boom') })
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText('boom')).not.toBeInTheDocument()
  })
})

describe('an undo toast', () => {
  it('says what happened and offers to take it back', () => {
    const undo = vi.fn()
    render(<Toaster />)
    act(() => { pushUndo('Removed from history', undo) })
    expect(screen.getByText('Removed from history')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Undo'))
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('is gone once taken back, so it can’t be pressed twice', () => {
    const undo = vi.fn()
    render(<Toaster />)
    act(() => { pushUndo('Removed from history', undo) })
    fireEvent.click(screen.getByText('Undo'))
    expect(screen.queryByText('Removed from history')).not.toBeInTheDocument()
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('can be waved away without undoing anything', () => {
    const undo = vi.fn()
    render(<Toaster />)
    act(() => { pushUndo('Removed from history', undo) })
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByText('Removed from history')).not.toBeInTheDocument()
    expect(undo).not.toHaveBeenCalled()
  })

  it('expires sooner than an error does — the offer belongs to the action', () => {
    render(<Harness />)
    act(() => { pushUndo('Removed from history', vi.fn()) })
    act(() => { vi.advanceTimersByTime(UNDO_MS - 1_000) })
    expect(screen.getByTestId('count')).toHaveTextContent('1')
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByTestId('count')).toHaveTextContent('0')
  })

  it('does nothing when the offer has already gone', () => {
    // The auto-dismiss fired while the pointer was on its way.
    const undo = vi.fn()
    let id = 0
    act(() => { id = pushUndo('Removed from history', undo) })
    act(() => { dismissToast(id) })
    act(() => { runUndo(id) })
    expect(undo).not.toHaveBeenCalled()
  })

  it('reads as an offer rather than as an error', () => {
    render(<Toaster />)
    act(() => { pushToast('GET /api/thing failed (500)'); pushUndo('Removed from history', vi.fn()) })
    expect(screen.getByText(/failed/).closest('button')?.textContent).toContain('⚠️')
    expect(screen.getByText('Removed from history').textContent).not.toContain('⚠️')
  })
})
