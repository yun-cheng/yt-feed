import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import NotesPanel from '../components/NotesPanel'
import type { VideoNotes } from '../components/NotesPanel'
import { useNotesOf, _resetCardNotes } from '../hooks/notesStore'

type Call = { url: string; method: string; body?: VideoNotes }

/** A server holding one video's notes and some suggestions, recording writes. */
function serve(notes: VideoNotes, suggestions = { labels: [] as string[], fields: {} as Record<string, string[]> }) {
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const json = url.includes('/suggestions') ? suggestions
      : method === 'PUT' ? JSON.parse(String(init!.body)) : notes
    return { ok: true, status: 200, json: async () => json, clone: () => ({ text: async () => '' }) }
  }) as unknown as typeof fetch
  return calls
}
const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT')

async function mount(videoId = 'vid1') {
  const view = render(<NotesPanel videoId={videoId} />)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return view
}
/** Past the save's wait. */
const settle = () => act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve() })

function type(label: string, text: string, key = 'Enter') {
  const box = screen.getByLabelText(label)
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key })
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); _resetCardNotes() })

describe('NotesPanel', () => {
  it('shows what was written before', async () => {
    serve({ labels: ['comedy'], fields: [{ name: 'Actors', values: ['Ann', 'Bo'] }], note: 'Good bit at 12:00' })
    await mount()
    expect(screen.getByText('comedy')).toBeInTheDocument()
    expect(screen.getByText('Actors')).toBeInTheDocument()
    expect(screen.getByText('Ann')).toBeInTheDocument()
    expect(screen.getByText('Bo')).toBeInTheDocument()
    expect(screen.getByLabelText('Note')).toHaveValue('Good bit at 12:00')
  })

  it('adds labels with Enter or a comma, and saves them a moment later, whole', async () => {
    const calls = serve({ labels: [], fields: [], note: '' })
    await mount()
    type('Add a label', 'comedy')
    type('Add a label', 'rewatch', ',')
    expect(screen.getByText('comedy')).toBeInTheDocument()
    expect(screen.getByText('rewatch')).toBeInTheDocument()
    expect(puts(calls)).toHaveLength(0)
    await settle()
    expect(puts(calls)).toHaveLength(1)
    expect(puts(calls)[0].url).toBe('/api/notes/video/vid1')
    expect(puts(calls)[0].body).toEqual({ labels: ['comedy', 'rewatch'], fields: [], note: '' })
  })

  it('a label typed again in another case is the same label', async () => {
    serve({ labels: ['Comedy'], fields: [], note: '' })
    await mount()
    type('Add a label', 'comedy')
    expect(screen.getAllByText(/comedy/i)).toHaveLength(1)
  })

  it('a field holds several values, each removable', async () => {
    const calls = serve({ labels: [], fields: [], note: '' })
    await mount()
    type('Add a field', 'Actors')
    type('Add to Actors', 'Ann')
    type('Add to Actors', 'Bo')
    type('Add to Actors', 'Cy')
    fireEvent.click(screen.getByLabelText('Remove Bo'))
    await settle()
    expect(puts(calls).at(-1)!.body!.fields).toEqual([{ name: 'Actors', values: ['Ann', 'Cy'] }])
  })

  it('a new field takes the cursor, ready for its first value', async () => {
    serve({ labels: [], fields: [], note: '' })
    await mount()
    type('Add a field', 'Actors')
    expect(screen.getByLabelText('Add to Actors')).toHaveFocus()
  })

  it('Backspace in an empty box takes back the last value', async () => {
    serve({ labels: ['a', 'b'], fields: [], note: '' })
    await mount()
    fireEvent.keyDown(screen.getByLabelText('Add a label'), { key: 'Backspace' })
    expect(screen.queryByText('b')).toBeNull()
    expect(screen.getByText('a')).toBeInTheDocument()
  })

  it('a field can be removed with everything in it', async () => {
    const calls = serve({ labels: [], fields: [{ name: 'Actors', values: ['Ann'] }], note: '' })
    await mount()
    fireEvent.click(screen.getByLabelText('Remove the field Actors'))
    expect(screen.queryByText('Ann')).toBeNull()
    await settle()
    expect(puts(calls).at(-1)!.body!.fields).toEqual([])
  })

  it('typing the note saves once, after the typing stops', async () => {
    const calls = serve({ labels: [], fields: [], note: '' })
    await mount()
    const box = screen.getByLabelText('Note')
    for (const text of ['G', 'Go', 'Goo', 'Good']) fireEvent.change(box, { target: { value: text } })
    await settle()
    expect(puts(calls)).toHaveLength(1)
    expect(puts(calls)[0].body!.note).toBe('Good')
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('a save reaches the cards, as the server kept it', async () => {
    serve({ labels: [], fields: [], note: '' })
    let seen: unknown
    function Card() { seen = useNotesOf('vid1'); return null }
    render(<Card />)
    await mount()
    type('Add a label', 'comedy')
    await settle()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(seen).toEqual({ labels: ['comedy'], fields: [] })
  })

  it('leaving the video sends what was still waiting', async () => {
    const calls = serve({ labels: [], fields: [], note: '' })
    const view = await mount()
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'half a thought' } })
    view.unmount()
    expect(puts(calls)).toHaveLength(1)
    expect(puts(calls)[0].body!.note).toBe('half a thought')
  })

  it('saves nothing just for opening', async () => {
    const calls = serve({ labels: ['kept'], fields: [], note: 'kept' })
    const view = await mount()
    await settle()
    view.unmount()
    expect(puts(calls)).toHaveLength(0)
  })

  it('offers what was used before, minus what is already here', async () => {
    serve(
      { labels: ['comedy'], fields: [{ name: 'Actors', values: ['Ann'] }], note: '' },
      { labels: ['comedy', 'rewatch'], fields: { actors: ['Ann', 'Bo'], Place: ['Oslo'] } },
    )
    const { container } = await mount()
    const options = (label: string) => {
      const id = screen.getByLabelText(label).getAttribute('list')
      return [...container.querySelectorAll(`datalist[id="${id}"] option`)].map((o) => o.getAttribute('value'))
    }
    expect(options('Add a label')).toEqual(['rewatch'])
    // A field's values are found by its name in any case.
    expect(options('Add to Actors')).toEqual(['Bo'])
    expect(options('Add a field')).toEqual(['Place'])
  })

  it('Escape hands the keyboard back to the player', async () => {
    serve({ labels: [], fields: [], note: '' })
    await mount()
    const box = screen.getByLabelText('Note')
    box.focus()
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    fireEvent.keyDown(box, { key: 'Escape' })
    window.removeEventListener('keydown', outer)
    expect(box).not.toHaveFocus()
    expect(outer).not.toHaveBeenCalled()
  })
})
