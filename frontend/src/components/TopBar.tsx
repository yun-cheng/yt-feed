import TimeSortControls from './TimeSortControls'

type Props = {
  variant?: 'feed' | 'channels' | 'channel' | 'watchlater' | 'downloads' | 'search'
  window: string
  onWindowChange: (w: string) => void
  sort: string
  onSortChange: (s: string) => void
  timeMode: string
  onTimeModeChange: (m: string) => void
  channelsSort?: string
  onChannelsSortChange?: (s: string) => void
  onToggleCollapse: () => void
  searchQuery?: string
  onSearchChange?: (q: string) => void
}

export default function TopBar({ variant, window, onWindowChange, sort, onSortChange, timeMode, onTimeModeChange, channelsSort, onChannelsSortChange, onToggleCollapse, searchQuery, onSearchChange }: Props) {
  const controls = variant === 'downloads' || variant === 'search' ? null : variant === 'watchlater' ? (
    <TimeSortControls
      variant="watchlater"
      sort={sort}
      onSortChange={onSortChange}
      window={window}
      onWindowChange={onWindowChange}
      timeMode={timeMode}
      onTimeModeChange={onTimeModeChange}
    />
  ) : variant === 'channels' ? (
    <TimeSortControls
      variant="channels"
      sort={channelsSort ?? 'subs'}
      onSortChange={onChannelsSortChange ?? (() => {})}
    />
  ) : (
    <TimeSortControls
      variant={variant}
      window={window}
      onWindowChange={onWindowChange}
      sort={sort}
      onSortChange={onSortChange}
      timeMode={timeMode}
      onTimeModeChange={onTimeModeChange}
    />
  )

  return (
    <header className="bg-[#0f0f0f]">
      {/* Row 1: (mobile menu button) + centered search */}
      <div className="flex items-center py-2">
        {/* Left: menu button — mobile only (desktop toggle + logo live in the sidebar) */}
        <div className="flex items-center px-4 flex-shrink-0 md:hidden">
          <button
            onClick={onToggleCollapse}
            className="text-[#aaa] hover:text-white transition-colors flex-shrink-0"
            aria-label="Toggle sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>

        {/* Search box — centered in row 1 */}
        <div className="flex-1 flex justify-center min-w-0 px-2 md:px-4">
          <div className="flex items-center w-full max-w-xl bg-[#121212] border border-[#303030] rounded-full focus-within:border-[#3ea6ff] transition-colors">
            <input
              value={searchQuery ?? ''}
              onChange={(e) => onSearchChange?.(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && searchQuery) { e.preventDefault(); onSearchChange?.('') } }}
              placeholder="Search"
              aria-label="Search"
              className="flex-1 min-w-0 bg-transparent pl-4 pr-2 py-1.5 text-sm text-white placeholder-[#717171] outline-none"
            />
            {searchQuery ? (
              <button
                onClick={() => onSearchChange?.('')}
                aria-label="Clear search"
                className="px-2 text-[#aaa] hover:text-white"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            ) : (
              <span className="px-3 text-[#717171]">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: filter/sort controls — all widths */}
      {controls && (
        <div className="px-4 pb-2">
          {controls}
        </div>
      )}
    </header>
  )
}
