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

// Imported and History have no time window: neither is a stream of new uploads,
// and filtering by publish date would hide most of the list (you watch and
// import old videos all the time). Both lead with 'recent' — the order the API
// already returns them in — labelled for what that order means on each page.
export function recentSortOptions(label: string) {
  return [{ value: 'recent', label }, ...SORT_OPTIONS]
}

export const CHANNEL_SORT_OPTIONS = [
  { value: 'subs', label: 'Subs' },
  { value: 'alpha', label: 'A-Z' },
] as const

// ── Props ──────────────────────────────────────────────────

type Props = {
  variant?: 'feed' | 'channels' | 'channel' | 'watchlater' | 'imported' | 'history'
  age?: TimeRange
  onAgeChange?: (r: TimeRange) => void
  count?: number
  sort: string
  onSortChange: (s: string) => void
}

// ── Inline time + sort (no TopBar wrapper) ─────────────────

export default function TimeSortControls({ variant = 'feed', age, onAgeChange, count, sort, onSortChange }: Props) {
  const effectiveVariant = variant === 'watchlater' ? 'feed' : variant
  if (effectiveVariant === 'channels' || effectiveVariant === 'imported' || effectiveVariant === 'history') {
    const options = effectiveVariant === 'channels'
      ? CHANNEL_SORT_OPTIONS
      : recentSortOptions(effectiveVariant === 'history' ? 'Watched' : 'Added')
    return (
      <div className="flex justify-end">
        <div className="flex gap-1 bg-[#1a1a1a] rounded-lg p-0.5">
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

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-6">
      {/* Row 1 on mobile / left on desktop: the time window */}
      {age && onAgeChange && (
        <TimeRangeSlider value={age} onChange={onAgeChange} count={count} />
      )}

      {/* Row 2 on mobile / right on desktop: sort buttons */}
      <div className="flex gap-1 bg-[#1a1a1a] rounded-lg p-0.5 md:ml-auto md:flex-shrink-0 overflow-x-auto no-scrollbar">
        {SORT_OPTIONS.map((opt) => (
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
