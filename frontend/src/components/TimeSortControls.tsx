import TimeRangeSlider from './TimeRangeSlider'
import type { TimeRange } from '../lib/timeWindow'

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

export const CHANNEL_SORT_OPTIONS = [
  { value: 'subs', label: 'Subs' },
  { value: 'alpha', label: 'A-Z' },
] as const

export type SortOption = { value: string; label: string }

// What each page can sort by. A page that's absent has no control bar at all —
// search, playlists, a local folder and settings each show one fixed order.
const PAGE_SORTS: Record<string, readonly SortOption[]> = {
  feed: SORT_OPTIONS,
  channel: SORT_OPTIONS,
  channels: CHANNEL_SORT_OPTIONS,
  watchlater: listSortOptions('Saved'),
  imported: listSortOptions('Added'),
  downloads: listSortOptions('Added'),
  history: listSortOptions('Watched'),
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
}

// ── Inline time + sort (no TopBar wrapper) ─────────────────

export default function TimeSortControls({ variant = 'feed', age, onAgeChange, count, sort, onSortChange }: Props) {
  const options = sortOptionsFor(variant) ?? SORT_OPTIONS
  const slider = age && onAgeChange

  return (
    <div className={slider ? 'flex flex-col gap-3 md:flex-row md:items-center md:gap-6' : 'flex justify-end'}>
      {/* Row 1 on mobile / left on desktop: the time window */}
      {slider && <TimeRangeSlider value={age} onChange={onAgeChange} count={count} />}

      {/* Row 2 on mobile / right on desktop: sort buttons */}
      <div className="flex gap-1 bg-[#1a1a1a] rounded-lg p-0.5 md:ml-auto md:flex-shrink-0 overflow-x-auto no-scrollbar">
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
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
