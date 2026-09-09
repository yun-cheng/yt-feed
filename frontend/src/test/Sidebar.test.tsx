import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Sidebar from '../components/Sidebar'
import type { TagInfo } from '../App'

// `group` has to match a key in the sidebar's GROUP_ORDER, which mirrors the
// backend taxonomy's groups (app/routers/tags.py). A tag whose group isn't one
// of those renders nowhere.
const mockTags: TagInfo[] = [
  { name: 'coding', group: 'Tech', icon: '💻', channel_count: 5 },
  { name: 'music', group: 'Music', icon: '🎵', channel_count: 3 },
]

const defaultProps = {
  tags: mockTags,
  selectedTags: [],
  onToggleTag: vi.fn(),
  onSetTags: vi.fn(),
  page: 'feed' as const,
  onPageChange: vi.fn(),
  onHome: vi.fn(),
  onToggleCollapse: vi.fn(),
  onClearFilter: vi.fn(),
  collapsed: false,
}

describe('Sidebar — expanded', () => {
  it('renders My Feed and Channels nav buttons', () => {
    render(<Sidebar {...defaultProps} />)
    // Both the sidebar logo and the Home nav item are labelled "My Feed".
    expect(screen.getAllByRole('button', { name: /My Feed/i }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Channels/i })).toBeInTheDocument()
  })

  it('renders tag groups', () => {
    render(<Sidebar {...defaultProps} />)
    expect(screen.getByText('Tech')).toBeInTheDocument()
    expect(screen.getByText('Music')).toBeInTheDocument()
  })

  it('skips groups that have no tags', () => {
    render(<Sidebar {...defaultProps} />)
    // Gaming is in GROUP_ORDER but no mock tag belongs to it.
    expect(screen.queryByText('Gaming')).not.toBeInTheDocument()
  })

  it('selects and deselects a whole group at once', () => {
    const onSetTags = vi.fn()
    render(<Sidebar {...defaultProps} onSetTags={onSetTags} />)
    fireEvent.click(screen.getByText('Tech').closest('button')!)
    expect(onSetTags).toHaveBeenCalledWith(['coding'])

    onSetTags.mockClear()
    render(<Sidebar {...defaultProps} selectedTags={['coding']} onSetTags={onSetTags} />)
    fireEvent.click(screen.getAllByText('Tech')[1].closest('button')!)
    expect(onSetTags).toHaveBeenCalledWith([])
  })

  it('renders tag buttons with counts', () => {
    render(<Sidebar {...defaultProps} />)
    expect(screen.getByText('coding').closest('button')).toHaveTextContent('5')
    expect(screen.getByText('music').closest('button')).toHaveTextContent('3')
  })

  it('prefers the filtered count over the channel count when given one', () => {
    // On a filtered feed the sidebar shows how many channels the CURRENT filter
    // leaves under each tag, not the tag's whole-feed total.
    render(<Sidebar {...defaultProps} tagFilteredCounts={new Map([['coding', 2]])} />)
    const coding = screen.getByText('coding').closest('button')!
    expect(coding).toHaveTextContent('2')
    // A tag missing from the map has nothing left under it.
    expect(screen.getByText('music').closest('button')).toHaveTextContent('0')
  })

  it('calls onToggleTag when a tag is clicked', () => {
    const onToggleTag = vi.fn()
    render(<Sidebar {...defaultProps} onToggleTag={onToggleTag} />)
    fireEvent.click(screen.getByText('coding').closest('button')!)
    expect(onToggleTag).toHaveBeenCalledWith('coding')
  })

  it('calls onPageChange when Channels is clicked', () => {
    const onPageChange = vi.fn()
    render(<Sidebar {...defaultProps} onPageChange={onPageChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Channels/i }))
    expect(onPageChange).toHaveBeenCalledWith('channels')
  })

  it('highlights active page in nav', () => {
    render(<Sidebar {...defaultProps} page="channels" />)
    const channelsBtn = screen.getByRole('button', { name: /Channels/i })
    expect(channelsBtn.className).toMatch(/bg-\[#272727\]/)
  })

  it('shows selected tags with active style', () => {
    render(<Sidebar {...defaultProps} selectedTags={['coding']} />)
    // The pill wraps both halves of the split chip, so it — not the body
    // button inside it — is what carries the state colour.
    const pill = screen.getByText('coding').closest('span.rounded-full')!
    expect(pill.className).toMatch(/bg-white/)
  })
})

// ── the split chip: only this / not this ─────────────────────

describe('Sidebar — a tag chip has two hit zones', () => {
  const body = (tag: string) => screen.getByText(tag).closest('button')!
  const minus = (tag: string) => screen.getByRole('button', { name: new RegExp(`hiding ${tag}|^Hide ${tag}`, 'i') })
  const pill = (tag: string) => screen.getByText(tag).closest('span.rounded-full')!

  it('the body asks for only this tag', () => {
    const onToggleTag = vi.fn()
    render(<Sidebar {...defaultProps} onToggleTag={onToggleTag} />)
    fireEvent.click(body('coding'))
    expect(onToggleTag).toHaveBeenCalledWith('coding')
  })

  it('the segment beside it asks for everything but this tag', () => {
    const onExcludeTag = vi.fn()
    const onToggleTag = vi.fn()
    render(<Sidebar {...defaultProps} onToggleTag={onToggleTag} onExcludeTag={onExcludeTag} />)
    fireEvent.click(minus('coding'))
    expect(onExcludeTag).toHaveBeenCalledWith('coding')
    // The two zones are genuinely separate — excluding must not also include.
    expect(onToggleTag).not.toHaveBeenCalled()
  })

  it('shows an excluded tag struck through and in the negative colour', () => {
    render(<Sidebar {...defaultProps} selectedTags={['-coding']} />)
    expect(pill('coding').className).toMatch(/bg-\[#5c2626\]/)
    expect(screen.getByText('coding').className).toMatch(/line-through/)
  })

  it('says which state each zone is in, for a test and for a screen reader', () => {
    render(<Sidebar {...defaultProps} selectedTags={['-coding']} />)
    expect(body('coding').dataset.state).toBe('excluded')
    expect(minus('coding').dataset.exclude).toBe('on')
    expect(minus('coding')).toHaveAccessibleName(/stop hiding coding/i)
  })

  it('leaves an unselected tag neutral in both zones', () => {
    render(<Sidebar {...defaultProps} />)
    expect(body('coding').dataset.state).toBe('off')
    expect(minus('coding').dataset.exclude).toBe('off')
    expect(pill('coding').className).toMatch(/bg-\[#272727\]/)
  })

  it('is inert rather than broken when nothing handles exclusion', () => {
    // `onExcludeTag` is optional — the channel-page sidebar renders topics
    // instead, and nothing there passes one.
    render(<Sidebar {...defaultProps} />)
    expect(() => fireEvent.click(minus('coding'))).not.toThrow()
  })
})

describe('Sidebar — collapsed', () => {
  it('renders icon + label for nav buttons', () => {
    render(<Sidebar {...defaultProps} collapsed={true} />)
    expect(screen.getByText('My Feed')).toBeInTheDocument()
    expect(screen.getByText('Channels')).toBeInTheDocument()
  })

  it('calls onPageChange when My Feed is clicked in collapsed state', () => {
    const onPageChange = vi.fn()
    render(<Sidebar {...defaultProps} collapsed={true} onPageChange={onPageChange} />)
    fireEvent.click(screen.getByText('My Feed').closest('button')!)
    expect(onPageChange).toHaveBeenCalledWith('feed')
  })
})

describe('Sidebar — Watch Later', () => {
  it('renders Watch Later nav button in expanded mode', () => {
    render(<Sidebar {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Watch Later/i })).toBeInTheDocument()
  })

  it('calls onPageChange with watchlater when clicked', () => {
    const onPageChange = vi.fn()
    render(<Sidebar {...defaultProps} onPageChange={onPageChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Watch Later/i }))
    expect(onPageChange).toHaveBeenCalledWith('watchlater')
  })

  it('shows watchLaterCount badge when count > 0', () => {
    render(<Sidebar {...defaultProps} watchLaterCount={7} />)
    // badge shows the count next to the Watch Later button
    const btn = screen.getByRole('button', { name: /Watch Later/i })
    expect(btn).toHaveTextContent('7')
  })

  it('shows 9+ badge in collapsed mode when count > 9', () => {
    render(<Sidebar {...defaultProps} collapsed={true} watchLaterCount={12} />)
    expect(screen.getByText('9+')).toBeInTheDocument()
  })

  it('highlights Watch Later button when page=watchlater', () => {
    render(<Sidebar {...defaultProps} page="watchlater" />)
    const btn = screen.getByRole('button', { name: /Watch Later/i })
    expect(btn.className).toMatch(/bg-\[#272727\]/)
  })

  it('renders Watch Later button in collapsed mode as "Later"', () => {
    render(<Sidebar {...defaultProps} collapsed={true} />)
    expect(screen.getByText('Later')).toBeInTheDocument()
  })
})

describe('Sidebar — saved presets', () => {
  const chinese = {
    id: 1,
    name: 'Chinese, unwatched',
    filters: { tags: ['chinese'], watch: ['unwatched'], summarised: false, shorts: false, hidden: false, length: null },
    created_at: null,
  }

  it('stays out of the way until there is a preset or something to save', () => {
    render(<Sidebar {...defaultProps} onApplyPreset={vi.fn()} presets={[]} onSavePreset={null} />)
    expect(screen.queryByText('Presets')).not.toBeInTheDocument()
  })

  it('offers to save once a filter is on', () => {
    render(<Sidebar {...defaultProps} onApplyPreset={vi.fn()} presets={[]} onSavePreset={vi.fn()} />)
    expect(screen.getByText('Presets')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save current/i })).toBeInTheDocument()
  })

  it('names a preset and saves it on Enter', () => {
    const onSavePreset = vi.fn()
    render(<Sidebar {...defaultProps} onApplyPreset={vi.fn()} presets={[]} onSavePreset={onSavePreset} />)
    fireEvent.click(screen.getByRole('button', { name: /save current/i }))
    const input = screen.getByLabelText('Preset name')
    // Trimmed here as well as server-side — the chip is drawn from what comes
    // back, but the warning about replacing an existing name compares locally.
    fireEvent.change(input, { target: { value: '  Evening  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSavePreset).toHaveBeenCalledWith('Evening')
  })

  it('warns before a save replaces one you already named', () => {
    render(<Sidebar {...defaultProps} onApplyPreset={vi.fn()} presets={[chinese]} onSavePreset={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /save current/i }))
    const input = screen.getByLabelText('Preset name')
    fireEvent.change(input, { target: { value: 'Chinese, unwatched' } })
    expect(screen.getByText(/replaces the preset/i)).toBeInTheDocument()
  })

  it('applies a preset when its chip is clicked', () => {
    const onApplyPreset = vi.fn()
    render(<Sidebar {...defaultProps} onApplyPreset={onApplyPreset} presets={[chinese]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Chinese, unwatched' }))
    expect(onApplyPreset).toHaveBeenCalledWith(chinese)
  })

  it('marks the preset currently in force', () => {
    const { container } = render(
      <Sidebar {...defaultProps} onApplyPreset={vi.fn()} presets={[chinese]} activePresetId={1} />)
    expect(container.querySelector('[data-active="on"]')).toBeInTheDocument()
  })

  it('deletes only on a second click, so one stray click cannot lose a preset', () => {
    const onDeletePreset = vi.fn()
    render(<Sidebar {...defaultProps} onApplyPreset={vi.fn()} presets={[chinese]} onDeletePreset={onDeletePreset} />)
    fireEvent.click(screen.getByRole('button', { name: /Delete Chinese, unwatched/i }))
    expect(onDeletePreset).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Confirm deleting Chinese, unwatched/i }))
    expect(onDeletePreset).toHaveBeenCalledWith(1)
  })

  it('arms without dressing the chip up as a crossed-out tag', () => {
    // The excluded-tag palette means "not this" everywhere else in this
    // sidebar. A pending delete reddens its own zone and says so in words.
    const { container } = render(
      <Sidebar {...defaultProps} onApplyPreset={vi.fn()} presets={[chinese]} onDeletePreset={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Delete Chinese, unwatched/i }))
    const chip = container.querySelector('[data-armed]')!.parentElement!
    expect(chip.className).not.toMatch(/#5c2626/)
    expect(screen.getByText('delete?')).toBeInTheDocument()
  })

  it('disarms a delete when you go and click the preset instead', () => {
    const onDeletePreset = vi.fn()
    const onApplyPreset = vi.fn()
    render(<Sidebar {...defaultProps} onApplyPreset={onApplyPreset} presets={[chinese]} onDeletePreset={onDeletePreset} />)
    fireEvent.click(screen.getByRole('button', { name: /Delete Chinese, unwatched/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Chinese, unwatched' }))
    expect(onDeletePreset).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Delete Chinese, unwatched/i })).toBeInTheDocument()
  })
})

describe('Sidebar — length chips', () => {
  // Every section is opt-in through `filters`; the default props leave it out,
  // so the chips only appear where a page says it can use them.
  const on = { watchStatus: false, tags: false, hidden: false, contentMode: false, summarised: false, length: true }

  it('is not rendered on a page that cannot use it', () => {
    render(<Sidebar {...defaultProps} onToggleLength={vi.fn()} filters={{ ...on, length: false }} />)
    expect(screen.queryByText('Length')).not.toBeInTheDocument()
  })

  it('is not rendered without a handler to call', () => {
    render(<Sidebar {...defaultProps} filters={on} />)
    expect(screen.queryByText('Length')).not.toBeInTheDocument()
  })

  it('offers one chip per bucket and reports which was clicked', () => {
    const onToggleLength = vi.fn()
    render(<Sidebar {...defaultProps} filters={on} onToggleLength={onToggleLength} />)
    for (const label of ['Under 5 min', '5–10 min', '10–20 min', 'Over 20 min']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: /5–10 min/ }))
    expect(onToggleLength).toHaveBeenCalledWith('5to10')
  })

  it('shows which buckets are on', () => {
    render(<Sidebar {...defaultProps} filters={on} lengths={['over20']} onToggleLength={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Over 20 min/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Under 5 min/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('turns the rest on from the header, and all of them off again', () => {
    // "Select all" only has to toggle what isn't already on — clicking a chip
    // that's on would turn it off, leaving the row half-selected.
    const onToggleLength = vi.fn()
    const { unmount } = render(
      <Sidebar {...defaultProps} filters={on} lengths={['under5']} onToggleLength={onToggleLength} />)
    fireEvent.click(screen.getByText('Length').closest('button')!)
    expect(onToggleLength.mock.calls.map(c => c[0])).toEqual(['5to10', '10to20', 'over20'])
    unmount()

    onToggleLength.mockClear()
    render(<Sidebar {...defaultProps} filters={on}
      lengths={['under5', '5to10', '10to20', 'over20']} onToggleLength={onToggleLength} />)
    fireEvent.click(screen.getByText('Length').closest('button')!)
    expect(onToggleLength.mock.calls.map(c => c[0])).toEqual(['under5', '5to10', '10to20', 'over20'])
  })
})
