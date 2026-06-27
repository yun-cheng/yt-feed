import type { TagInfo } from '../App'

// ── Constants ──────────────────────────────────────────────

export const WINDOWS = [
  { value: '1d', label: '1d' },
  { value: '3d', label: '3d' },
  { value: '1w', label: '1w' },
  { value: '2w', label: '2w' },
  { value: '1m', label: '1m' },
  { value: '3m', label: '3m' },
  { value: '6m', label: '6m' },
  { value: '1y', label: '1y' },
] as const

export const SORT_OPTIONS = [
  { value: 'views', label: 'Views' },
  { value: 'score', label: 'Hot' },
  { value: 'likes', label: 'Likes' },
  { value: 'like%', label: 'Like%' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
] as const

export const CHANNEL_SORT_OPTIONS = [
  { value: 'subs', label: 'Subs' },
  { value: 'alpha', label: 'A-Z' },
] as const

// ── Props ──────────────────────────────────────────────────

type Props = {
  variant?: 'feed' | 'channels' | 'channel' | 'watchlater'
  window?: string
  onWindowChange?: (w: string) => void
  sort: string
  onSortChange: (s: string) => void
  timeMode?: string
  onTimeModeChange?: (m: string) => void
}

// ── Inline time + sort (no TopBar wrapper) ─────────────────

export default function TimeSortControls({ variant = 'feed', window, onWindowChange, sort, onSortChange, timeMode, onTimeModeChange }: Props) {
  const effectiveVariant = variant === 'watchlater' ? 'feed' : variant
  if (effectiveVariant === 'channels') {
    return (
      <div className="flex justify-end">
        <div className="flex gap-1 bg-[#1a1a1a] rounded-lg p-0.5">
          {CHANNEL_SORT_OPTIONS.map((opt) => (
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
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      {/* Row 1 on mobile / left on desktop: time window buttons + narrow/wide toggle */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex gap-1 overflow-x-auto no-scrollbar flex-shrink-0">
          {WINDOWS.map((w, i) => {
            const selectedIdx = WINDOWS.findIndex((x) => x.value === window)
            const isSelected = timeMode === 'wide' ? i <= selectedIdx : window === w.value
            return (
              <button
                key={w.value}
                onClick={() => onWindowChange?.(w.value)}
                className={`px-3 py-1.5 text-sm rounded-full transition-colors ${
                  isSelected
                    ? 'bg-white text-black font-medium'
                    : 'bg-[#272727] text-white hover:bg-[#3a3a3a]'
                }`}
              >
                {w.label}
              </button>
            )
          })}
        </div>

        {/* Narrow / Wide mode toggle */}
        <div className="flex items-center bg-[#1a1a1a] rounded-full p-0.5 text-xs">
          <button
            onClick={() => onTimeModeChange?.('narrow')}
            className={`px-2.5 py-1 rounded-full transition-colors ${
              timeMode === 'narrow'
                ? 'bg-[#272727] text-white font-medium'
                : 'text-[#666] hover:text-white'
            }`}
          >
            Narrow
          </button>
          <button
            onClick={() => onTimeModeChange?.('wide')}
            className={`px-2.5 py-1 rounded-full transition-colors ${
              timeMode === 'wide'
                ? 'bg-[#272727] text-white font-medium'
                : 'text-[#666] hover:text-white'
            }`}
          >
            Wide
          </button>
        </div>
      </div>

      {/* Row 2 on mobile / right on desktop: sort buttons */}
      <div className="flex gap-1 bg-[#1a1a1a] rounded-lg p-0.5 md:ml-auto overflow-x-auto no-scrollbar">
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
