import TimeSortControls from './TimeSortControls'
import type { TagInfo } from '../App'

type Props = {
  variant?: 'feed' | 'channels' | 'channel'
  window: string
  onWindowChange: (w: string) => void
  sort: string
  onSortChange: (s: string) => void
  timeMode: string
  onTimeModeChange: (m: string) => void
  channelsSort?: string
  onChannelsSortChange?: (s: string) => void
  selectedTags: string[]
  tags: TagInfo[]
  onToggleTag: (tag: string) => void
  onClearFilter: () => void
  /** When true, normal time/sort controls are not rendered (shown in page content instead) */
  hideControls?: boolean
  /** Takeover mode: show channel's time/sort in the sticky header */
  showTakeover?: boolean
  takeoverWindow?: string
  takeoverSort?: string
  takeoverTimeMode?: string
  onTakeoverWindowChange?: (w: string) => void
  onTakeoverSortChange?: (s: string) => void
  onTakeoverTimeModeChange?: (m: string) => void
}

export default function TopBar({ variant, window, onWindowChange, sort, onSortChange, timeMode, onTimeModeChange, channelsSort, onChannelsSortChange, selectedTags, tags, onToggleTag, onClearFilter, hideControls, showTakeover, takeoverWindow, takeoverSort, takeoverTimeMode, onTakeoverWindowChange, onTakeoverSortChange, onTakeoverTimeModeChange }: Props) {
  return (
    <header className="sticky top-0 z-20 bg-[#0f0f0f]">
      {/* Row 1: normal time + sort (shown on feed/channels, hidden on channel page) */}
      {!hideControls && (
        <div className="px-6 py-3 border-b border-[#272727]">
          {variant === 'channels' ? (
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
          )}
        </div>
      )}

      {/* Takeover row: channel page time + sort (sticky inside TopBar) */}
      {showTakeover && takeoverWindow !== undefined && takeoverSort !== undefined && onTakeoverWindowChange && onTakeoverSortChange && (
        <div className="px-6 py-3 border-b border-[#272727]">
          <TimeSortControls
            variant="channel"
            window={takeoverWindow}
            onWindowChange={onTakeoverWindowChange}
            sort={takeoverSort}
            onSortChange={onTakeoverSortChange}
            timeMode={takeoverTimeMode ?? 'narrow'}
            onTimeModeChange={onTakeoverTimeModeChange ?? (() => {})}
          />
        </div>
      )}

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
