/**
 * The Markdown answers arrive in.
 *
 * The load-bearing test is the last group: a timestamp has to survive every
 * wrapper — a bullet, a bold run, a nested sub-item — and still seek. That's the
 * whole reason this renderer exists instead of a dependency.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { parseBlocks, renderMarkdown } from '../lib/markdown'

const show = (src: string, onSeek = vi.fn()) =>
  render(<div data-testid="md">{renderMarkdown(src, onSeek)}</div>)

const md = () => screen.getByTestId('md')

describe('parseBlocks', () => {
  it('reads a heading and its level', () => {
    expect(parseBlocks('## Key points')).toEqual([{ kind: 'heading', level: 2, text: 'Key points' }])
  })

  it('joins wrapped lines into one paragraph and splits on the blank line', () => {
    expect(parseBlocks('one\ntwo\n\nthree')).toEqual([
      { kind: 'para', text: 'one two' },
      { kind: 'para', text: 'three' },
    ])
  })

  it('gathers consecutive bullets into a single list', () => {
    const [b] = parseBlocks('- a\n- b\n- c')
    expect(b).toMatchObject({ kind: 'list', ordered: false })
    expect(b.kind === 'list' && b.items.map((i) => i.text)).toEqual(['a', 'b', 'c'])
  })

  it('tells a numbered list from a bulleted one', () => {
    expect(parseBlocks('1. first\n2. second')[0]).toMatchObject({ kind: 'list', ordered: true })
  })

  it('an indented bullet belongs to the one above it', () => {
    const [b] = parseBlocks('- S Tier\n    - Fable 5\n    - 56 Soul\n- A Tier')
    expect(b.kind === 'list' && b.items.map((i) => [i.text, i.children])).toEqual([
      ['S Tier', ['Fable 5', '56 Soul']],
      ['A Tier', []],
    ])
  })

  it('does not merge a numbered list into a bulleted one', () => {
    expect(parseBlocks('- a\n1. b').map((b) => b.kind)).toEqual(['list', 'list'])
  })
})

describe('renderMarkdown', () => {
  it('bold becomes bold, and keeps only its own text', () => {
    show('**Fable 5** is the pick')
    expect(md().querySelector('strong')?.textContent).toBe('Fable 5')
    expect(md().textContent).toBe('Fable 5 is the pick')
  })

  it('italics render without eating the asterisks of a bold run', () => {
    show('**bold** and *italic*')
    expect(md().querySelector('strong')?.textContent).toBe('bold')
    expect(md().querySelector('em')?.textContent).toBe('italic')
  })

  it('asterisks inside a code span stay literal', () => {
    show('call `a ** b` here')
    expect(md().querySelector('code')?.textContent).toBe('a ** b')
    expect(md().querySelector('strong')).toBeNull()
  })

  it('a list renders as a list, not as run-together text', () => {
    show('- first\n- second')
    expect(md().querySelectorAll('ul > li')).toHaveLength(2)
  })

  it('a numbered list renders as one', () => {
    show('1. first\n2. second')
    expect(md().querySelector('ol')).toBeTruthy()
  })

  it('sub-items nest inside their parent', () => {
    show('- S Tier\n    - Fable 5')
    const outer = md().querySelector('ul > li')
    expect(outer?.querySelector('ul > li')?.textContent).toBe('Fable 5')
  })

  it('unhandled syntax degrades to text rather than vanishing', () => {
    show('> a quote\n\n| a | table |')
    expect(md().textContent).toContain('a quote')
    expect(md().textContent).toContain('table')
  })

  // ── the point of the whole thing ──────────────────────────────────

  it('a timestamp in a paragraph seeks', () => {
    const onSeek = vi.fn()
    show('They say so at [12:34].', onSeek)
    fireEvent.click(screen.getByRole('button', { name: '12:34' }))
    expect(onSeek).toHaveBeenCalledWith(754)
  })

  it('a timestamp inside a bullet seeks', () => {
    const onSeek = vi.fn()
    show('- **Fable 5** — the only S tier [31:02]', onSeek)
    fireEvent.click(screen.getByRole('button', { name: '31:02' }))
    expect(onSeek).toHaveBeenCalledWith(1862)
  })

  it('a timestamp inside a bold run seeks', () => {
    const onSeek = vi.fn()
    show('the gap opens at **[33:59]**', onSeek)
    fireEvent.click(screen.getByRole('button', { name: '33:59' }))
    expect(onSeek).toHaveBeenCalledWith(2039)
  })

  it('a timestamp in a nested sub-item seeks', () => {
    const onSeek = vi.fn()
    show('- A Tier\n    - Luna [7:00]', onSeek)
    fireEvent.click(screen.getByRole('button', { name: '7:00' }))
    expect(onSeek).toHaveBeenCalledWith(420)
  })

  it('an hour-long stamp still resolves', () => {
    const onSeek = vi.fn()
    show('- late on [1:02:03]', onSeek)
    fireEvent.click(screen.getByRole('button', { name: '1:02:03' }))
    expect(onSeek).toHaveBeenCalledWith(3723)
  })

  it('a link in an answer is still a link', () => {
    show('see https://example.test/x for more')
    expect(md().querySelector('a')?.getAttribute('href')).toBe('https://example.test/x')
  })
})
