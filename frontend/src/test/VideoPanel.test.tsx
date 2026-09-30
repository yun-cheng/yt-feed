/**
 * The panel over the video keeps what its tabs hold. A tab you leave is hidden,
 * not thrown away, and so is the whole panel when you close it — the scroll,
 * the opened replies and the half-typed question are all still there when you
 * come back.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import VideoPanel, { PanelTab } from '../components/VideoPanel'
import type { VideoPanelTab } from '../lib/videoPanel'

function Draft() {
  const [text, setText] = useState('')
  return <textarea aria-label="Draft" value={text} onChange={(e) => setText(e.target.value)} />
}

function Harness() {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<VideoPanelTab>('ask')
  return (
    <>
      <button onClick={() => setOpen((v) => !v)}>Toggle</button>
      <VideoPanel
        open={open}
        tabs={[
          { key: 'info', label: 'Info', icon: null },
          { key: 'ask', label: 'Ask AI', icon: null },
        ]}
        tab={tab} onTab={setTab} side="right" onSwapSide={vi.fn()}
        onClose={() => setOpen(false)} width="20rem" bottom="0px"
      >
        <PanelTab shown={tab === 'info'}><p>About</p></PanelTab>
        <PanelTab shown={tab === 'ask'}><Draft /></PanelTab>
      </VideoPanel>
    </>
  )
}

describe('VideoPanel', () => {
  it('keeps a tab it switched away from', () => {
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'why?' } })

    fireEvent.click(screen.getByRole('tab', { name: 'Info' }))
    expect(screen.getByLabelText('Draft')).not.toBeVisible()  // hidden, not unmounted

    fireEvent.click(screen.getByRole('tab', { name: 'Ask AI' }))
    expect(screen.getByLabelText('Draft')).toHaveValue('why?')
  })

  it('keeps its tabs when closed, and hides itself', () => {
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'why?' } })

    fireEvent.click(screen.getByRole('button', { name: 'Hide the panel' }))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
    expect(screen.getByLabelText('Draft')).toHaveValue('why?')
  })
})
