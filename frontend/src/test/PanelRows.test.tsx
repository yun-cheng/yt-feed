import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelRows } from '../components/WatchPage'

// The list behind the panel's Transcript, Chapters and Bookmarks tabs.

const rows = [
  { start: 0, text: 'Intro' },
  { start: 65, text: 'The middle' },
  { start: 600, text: 'The end' },
]

// jsdom lays nothing out, so the box and its rows are placed by hand.
function place(el: Element, top: number, bottom: number) {
  el.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) })
}

const realScrollTo = HTMLElement.prototype.scrollTo
let scrollTo: ReturnType<typeof vi.fn>
beforeEach(() => {
  scrollTo = vi.fn()
  HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo
})
afterEach(() => { HTMLElement.prototype.scrollTo = realScrollTo })

describe('PanelRows', () => {
  it('draws each row as its time and line, and seeks to it on click', () => {
    const onSeek = vi.fn()
    render(<PanelRows rows={rows} activeRow={-1} onSeek={onSeek} />)
    expect(screen.getByText('1:05')).toBeInTheDocument()
    fireEvent.click(screen.getByText('The end'))
    expect(onSeek).toHaveBeenCalledWith(600)
  })

  it('marks the row the play head is in', () => {
    render(<PanelRows rows={rows} activeRow={1} onSeek={() => {}} />)
    const row = (text: string) => screen.getByText(text).closest('button')!.parentElement!
    expect(row('The middle')).toHaveClass('bg-white/15')
    expect(row('Intro')).not.toHaveClass('bg-white/15')
  })

  it('draws a row’s picture ahead of its time, and its action beside it', () => {
    const onSeek = vi.fn()
    const remove = vi.fn()
    render(
      <PanelRows
        rows={rows}
        activeRow={-1}
        onSeek={onSeek}
        leading={(i) => <img alt={`moment ${i}`} />}
        trailing={(i) => <button onClick={() => remove(i)}>remove {i}</button>}
      />,
    )
    // The picture is part of the row's seek button; the action is not.
    const seek = screen.getByText('Intro').closest('button')!
    expect(seek).toContainElement(screen.getByAltText('moment 0'))
    expect(seek).not.toContainElement(screen.getByText('remove 0'))
    fireEvent.click(screen.getByText('remove 2'))
    expect(remove).toHaveBeenCalledWith(2)
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('says what the tab holds while it’s empty, unless rows are still coming', () => {
    const { rerender } = render(<PanelRows rows={[]} activeRow={-1} onSeek={() => {}} empty="No bookmarks yet" />)
    expect(screen.getByText('No bookmarks yet')).toBeInTheDocument()
    rerender(<PanelRows rows={[]} activeRow={-1} onSeek={() => {}} empty="No bookmarks yet" busy />)
    expect(screen.queryByText('No bookmarks yet')).not.toBeInTheDocument()
    expect(screen.getByText('Translating…')).toBeInTheDocument()
  })

  it('stops following once the active row is scrolled away, and Sync to video resumes', () => {
    const { container } = render(<PanelRows rows={rows} activeRow={1} onSeek={() => {}} />)
    const box = container.querySelector('.overflow-y-auto')!
    const active = screen.getByText('The middle').closest('button')!.parentElement!
    place(box, 0, 100)

    // Still in view: nothing to sync.
    place(active, 40, 60)
    fireEvent.scroll(box)
    expect(screen.queryByLabelText('Sync to video')).not.toBeInTheDocument()

    place(active, 300, 320)
    fireEvent.scroll(box)
    scrollTo.mockClear()
    fireEvent.click(screen.getByLabelText('Sync to video'))
    expect(screen.queryByLabelText('Sync to video')).not.toBeInTheDocument()
    // Back on the row, centred in the box alone.
    expect(scrollTo).toHaveBeenCalled()
  })

  it('clicking a row while scrolled away follows again', () => {
    const { container } = render(<PanelRows rows={rows} activeRow={1} onSeek={() => {}} />)
    const box = container.querySelector('.overflow-y-auto')!
    place(box, 0, 100)
    place(screen.getByText('The middle').closest('button')!.parentElement!, 300, 320)
    fireEvent.scroll(box)
    fireEvent.click(screen.getByText('Intro'))
    expect(screen.queryByLabelText('Sync to video')).not.toBeInTheDocument()
  })
})
