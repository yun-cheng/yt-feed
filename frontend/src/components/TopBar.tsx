import type { TagInfo } from '../App'

const WINDOWS = [
  { value: '1d', label: '1d' },
  { value: '3d', label: '3d' },
  { value: '1w', label: '1w' },
  { value: '2w', label: '2w' },
  { value: '1m', label: '1m' },
  { value: '3m', label: '3m' },
  { value: '6m', label: '6m' },
  { value: '1y', label: '1y' },
] as const

type Props = {
  window: string
  onWindowChange: (w: string) => void
  sort: string
  onSortChange: (s: string) => void
  selectedTags: string[]
  tags: TagInfo[]
  onToggleTag: (tag: string) => void
  onClearFilter: () => void
}

const SORT_OPTIONS = [
  { value: 'score', label: 'Hot' },
  { value: 'views', label: 'Views' },
  { value: 'likes', label: 'Likes' },
  { value: 'like%', label: 'Like%' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
]

export default function TopBar({ window, onWindowChange, sort, onSortChange, selectedTags, tags, onToggleTag, onClearFilter }: Props) {
  return (
    <header className="sticky top-0 z-20 bg-[#0f0f0f]">
      {/* Row 1: time + sort */}
      <div className="px-6 py-3 border-b border-[#272727]">
        <div className="flex items-center gap-4">
            {/* Time window buttons */}
            <div className="flex gap-1">
              {WINDOWS.map((w) => (
                <button
                  key={w.value}
                  onClick={() => onWindowChange(w.value)}
                  className={`px-3 py-1.5 text-sm rounded-full transition-colors ${
                    window === w.value
                      ? 'bg-white text-black font-medium'
                      : 'bg-[#272727] text-white hover:bg-[#3a3a3a]'
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </div>

            {/* Sort */}
            <div className="ml-auto flex gap-1 bg-[#1a1a1a] rounded-lg p-0.5">
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
        </div>

      {/* Row 2: active filters (only when tags selected) */}
      {selectedTags.length > 0 && (
        <div className="px-6 py-2 border-b border-[#272727] bg-[#0d0d0d]">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#555] font-medium">Filters:</span>
            <div className="flex flex-wrap gap-1.5">
              {selectedTags.map((tag) => {
                const info = tags.find(t => t.name === tag)
                return (
                  <button
                    key={tag}
                    onClick={() => onToggleTag(tag)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full bg-white text-black font-medium hover:opacity-80 transition-opacity"
                  >
                    <span>{info?.icon || '🏷️'}</span>
                    <span>{tag}</span>
                    <span className="ml-0.5 text-black/40 font-bold">×</span>
                  </button>
                )
              })}
            </div>
            <button
              onClick={onClearFilter}
              className="ml-1 text-xs text-[#555] hover:text-white transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </header>
  )
}