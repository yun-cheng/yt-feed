import TimeSortControls from './TimeSortControls'

type Props = {
  variant?: 'feed' | 'channels' | 'channel' | 'watchlater'
  window: string
  onWindowChange: (w: string) => void
  sort: string
  onSortChange: (s: string) => void
  timeMode: string
  onTimeModeChange: (m: string) => void
  channelsSort?: string
  onChannelsSortChange?: (s: string) => void
  onToggleCollapse: () => void
  onHome: () => void
  sidebarCollapsed?: boolean
}

export default function TopBar({ variant, window, onWindowChange, sort, onSortChange, timeMode, onTimeModeChange, channelsSort, onChannelsSortChange, onToggleCollapse, onHome, sidebarCollapsed }: Props) {
  const controls = variant === 'watchlater' ? (
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
    <header className="bg-[#0f0f0f] border-b border-[#272727]">
      {/* Row 1: hamburger + logo (+ controls on desktop) */}
      <div className="flex items-center py-2">
        {/* Left section — on desktop matches sidebar width; on mobile just wraps content */}
        <div className={`flex items-center gap-2 px-4 flex-shrink-0 transition-[width] duration-200 ${sidebarCollapsed ? 'md:w-16' : 'md:w-60'}`}>
          <button
            onClick={onToggleCollapse}
            className="text-[#aaa] hover:text-white transition-colors flex-shrink-0"
            aria-label="Toggle sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <button
            onClick={onHome}
            className={`flex items-center gap-2 hover:opacity-80 transition-opacity flex-shrink-0 ${sidebarCollapsed ? 'hidden md:hidden' : ''}`}
          >
            <svg className="w-6 h-6 text-red-500" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0C.488 3.45.029 5.804 0 12c.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0C23.512 20.55 23.971 18.196 24 12c-.029-6.185-.484-8.549-4.385-8.816zM9 16V8l8 4-8 4z"/>
            </svg>
            <span className="text-sm font-semibold tracking-tight hidden md:inline">My Feed</span>
          </button>
        </div>

        {/* Controls — desktop only in this row */}
        <div className="hidden md:block flex-1 min-w-0 px-4">
          {controls}
        </div>
      </div>

      {/* Row 2: controls — mobile only */}
      <div className="md:hidden px-3 pb-2">
        {controls}
      </div>
    </header>
  )
}
