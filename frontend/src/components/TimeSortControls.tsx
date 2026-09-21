import TimeRangeSlider from './TimeRangeSlider'
import type { TimeRange } from '../lib/timeWindow'
import { tc } from '../lib/i18n'

// ── Constants ──────────────────────────────────────────────

export const SORT_OPTIONS = [
  { value: 'views', label: 'Views' },
  { value: 'score', label: 'Hot' },
  { value: 'likes', label: 'Likes' },
  { value: 'like%', label: 'Like%' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
] as const

// The library pages lead with 'recent' — the order the API already returns them
// in — labelled for what that order means on each one. It's the same token
// everywhere because it means the same thing everywhere: the order this list
// keeps itself in, which is when each row joined it. Only the word differs.
function listSortOptions(label: string) {
  return [{ value: 'recent', label }, ...SORT_OPTIONS]
}

// Meilisearch's own order for a query's hits. Offered only while a search is
// running (see `searching`), because there is nothing to be relevant to
// otherwise — and it leads the row, being the order a search arrives in.
export const RELEVANCE_SORT = { value: 'relevance', label: 'Relevance' } as const

export const CHANNEL_SORT_OPTIONS = [
  { value: 'subs', label: 'Subs' },
  { value: 'alpha', label: 'A-Z' },
] as const

export type SortOption = { value: string; label: string }

// What each page can sort by. A page that's absent has no control bar at all —
// search, the playlists grid, a local folder and settings each show one fixed
// order.
const PAGE_SORTS: Record<string, readonly SortOption[]> = {
  feed: SORT_OPTIONS,
  channel: SORT_OPTIONS,
  channels: CHANNEL_SORT_OPTIONS,
  watchlater: listSortOptions('Saved'),
  imported: listSortOptions('Added'),
  downloads: listSortOptions('Added'),
  history: listSortOptions('Watched'),
  // One playlist is a library page like the four above — a list you assembled
  // on purpose — so it gets the same bar. 'Order' rather than 'Added' because
  // an imported playlist's order is YouTube's, deliberately preserved, and
  // that's what the default leaves alone.
  playlist: listSortOptions('Order'),
}

/** The sort buttons a page offers, or undefined if it has no bar. */
export const sortOptionsFor = (page: string): readonly SortOption[] | undefined => PAGE_SORTS[page]

// ── Props ──────────────────────────────────────────────────

type Props = {
  variant?: string
  // Given only on pages that have a time window; without it the slider is
  // simply absent and the sort buttons sit alone on the right.
  age?: TimeRange
  onAgeChange?: (r: TimeRange) => void
  count?: number
  sort: string
  onSortChange: (s: string) => void
  // A search is narrowing this page right now, so relevance is on the table.
  searching?: boolean
  // Slider above the sort row at every width, for a narrow column (the
  // settings page) rather than a page-wide bar.
  stacked?: boolean
}

// ── Inline time + sort (no TopBar wrapper) ─────────────────

export default function TimeSortControls({ variant = 'feed', age, onAgeChange, count, sort, onSortChange, searching = false, stacked = false }: Props) {
  const base = sortOptionsFor(variant) ?? SORT_OPTIONS
  const options = searching ? [RELEVANCE_SORT, ...base] : base
  const slider = age && onAgeChange

  return (
    <div className={stacked ? 'flex flex-col items-start gap-3' : slider ? 'flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-6' : 'flex justify-end'}>
      {/* Row 1 on its own / left on a wide page: the time window.
          Side by side only from `lg`, not `md`: at 768 the sidebar is back and
          the sort row is ~330px, which leaves the slider too narrow to hold its
          twelve labels. They're absolutely positioned by percentage, so they
          don't wrap when squeezed — they overlap into a smear. */}
      {slider && <TimeRangeSlider value={age} onChange={onAgeChange} count={count} />}

      {/* Row 2 on mobile / right on desktop: sort buttons */}
      <div className={`flex gap-1 bg-[#1a1a1a] rounded-lg p-0.5 overflow-x-auto no-scrollbar max-w-full ${stacked ? '' : 'lg:ml-auto lg:flex-shrink-0'}`}>
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onSortChange(opt.value)}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
              sort === opt.value
                ? 'bg-[#272727] text-white font-medium'
                : 'text-[#888] hover:text-white'
            }`}
          >
            {tc('sort', opt.label)}
          </button>
        ))}
      </div>
    </div>
  )
}
