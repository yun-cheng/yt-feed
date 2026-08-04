import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pushToast, dismissToast, useToasts } from '../hooks/toastStore'
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
