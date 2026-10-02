import TimeSortControls, { sortOptionsFor } from './TimeSortControls'
import NotificationBell from './NotificationBell'
import type { TimeRange } from '../lib/timeWindow'
import { t } from '../lib/i18n'

export type TopBarVariant =
  | 'feed' | 'channels' | 'channel' | 'watchlater' | 'downloads' | 'search'
  | 'playlists' | 'playlist' | 'imported' | 'history' | 'local' | 'settings'

export type ContentMode = 'videos' | 'shorts'

const ShortsIcon = () => (
  <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M10 8.64v6.72L15.27 12 10 8.64zM17.77 10.32c1.71.94 2.38 3.09 1.5 4.82-.34.67-.87 1.2-1.5 1.55l-6.9 3.8c-1.71.94-3.86.31-4.8-1.4-.94-1.71-.31-3.86 1.4-4.8l.4-.22-.4-.22c-1.71-.94-2.34-3.09-1.4-4.8.94-1.71 3.09-2.34 4.8-1.4l6.9 3.8z"/>
  </svg>
)

const VideosIcon = () => (
  <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M4 5a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2v-3l4 3V7l-4 3V7a2 2 0 00-2-2H4z"/>
  </svg>
)

// Videos ↔ Shorts: what the feed / channel / history pages show. One track, the
// choice lit inside it, two equal columns so lighting the other half never
// shifts anything. Its words go where the header is narrow (the header is the
// container), leaving the icons, which is why each half carries its name as a
// label and tooltip too.
const ContentModeSwitch = ({ mode, onChange }: { mode: ContentMode; onChange: (m: ContentMode) => void }) => (
  <div className="grid flex-shrink-0 grid-cols-2 rounded-full bg-[#272727] p-0.5 text-sm">
    {(['videos', 'shorts'] as const).map((m) => {
      const label = m === 'videos' ? t('Videos') : t('Shorts')
      return (
        <button
          key={m}
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          aria-label={label}
          title={label}
          className={`flex items-center justify-center gap-1.5 rounded-full px-3 py-[5px] font-medium transition-colors ${
            mode === m ? 'bg-white text-black' : 'text-[#aaa] hover:text-white'
          }`}
        >
          {m === 'videos' ? <VideosIcon /> : <ShortsIcon />}
          <span className="hidden @min-[48rem]:inline">{label}</span>
        </button>
      )
    })}
  </div>
)

type Props = {
  variant?: TopBarVariant
  // Absent on a page with no time window — that's what hides the slider.
  age?: TimeRange
  onAgeChange: (r: TimeRange) => void
  count?: number
  sort: string
  onSortChange: (s: string) => void
  onToggleCollapse: () => void
  searchQuery?: string
  onSearchChange?: (q: string) => void
  onSearchFocus?: () => void
  // Search scope. A search normally covers every channel you follow; this one
  // button narrows it to the channel on screen and widens it again. Present
  // only when there IS such a channel; `scoped` is whether it's on.
  scoped?: boolean
  onScopeToggle?: () => void
  // What the scope is — "In this channel", "In history".
  scopeLabel?: string
  // Passed through to the sort row: a search is narrowing the page, so it can
  // offer to order by relevance.
  searching?: boolean
  // Set on the Imported page: renders the "Import" button at the top right.
  onImport?: () => void
  // Present only on the pages that split into Videos and Shorts.
  contentMode?: ContentMode
  onContentModeChange?: (m: ContentMode) => void
}

export default function TopBar({ variant = 'feed', age, onAgeChange, count, sort, onSortChange, onToggleCollapse, searchQuery, onSearchChange, onSearchFocus, scoped = false, onScopeToggle, scopeLabel = t('In this channel'), searching, onImport, contentMode = 'videos', onContentModeChange }: Props) {
  // Search, playlists, local folders and settings show no bar at all: their
  // order is the library's own and there's nothing to window. Every other page
  // gets its own sort buttons, and the slider only if a window came with them.
  const controls = sortOptionsFor(variant) && (
    <TimeSortControls
      variant={variant}
      age={age}
      onAgeChange={onAgeChange}
      count={count}
      sort={sort}
      onSortChange={onSortChange}
      searching={searching}
    />
  )

  return (
    <header className="@container bg-[#0f0f0f]">
      {/* Row 1: (mobile menu button) + the Videos / Shorts switch at the left,
          the search centered in what's left */}
      <div className="flex items-center py-2">
        {/* Left: menu button — mobile only (desktop toggle + logo live in the
            sidebar) — then the switch, on the pages that have one, lined up
            with the page's content below. */}
        <div className={`flex items-center gap-3 pl-4 flex-shrink-0 ${onContentModeChange ? '' : 'md:hidden'}`}>
          <button
            onClick={onToggleCollapse}
            className="text-[#aaa] hover:text-white transition-colors flex-shrink-0 md:hidden"
            aria-label={t('Toggle sidebar')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          {onContentModeChange && <ContentModeSwitch mode={contentMode} onChange={onContentModeChange} />}
        </div>

        <div className="flex-1 flex justify-center min-w-0 px-2 md:px-4">
          <div className="flex items-center w-full min-w-0 max-w-xl bg-[#121212] border border-[#303030] rounded-full focus-within:border-[#3ea6ff] transition-colors">
            <input
              value={searchQuery ?? ''}
              onChange={(e) => onSearchChange?.(e.target.value)}
              onFocus={() => onSearchFocus?.()}
              onKeyDown={(e) => { if (e.key === 'Escape' && searchQuery) { e.preventDefault(); onSearchChange?.('') } }}
              placeholder={t('Search')}
              aria-label={t('Search')}
              className="flex-1 min-w-0 bg-transparent pl-4 pr-2 py-1.5 text-sm text-white placeholder-[#717171] outline-none"
            />
            {onScopeToggle && (
              /* One button, two states — the same words either way, because
                 what it does never changes. Lit means the search is confined to
                 the channel on screen; clicking it again widens back out. */
              <button
                onClick={onScopeToggle}
                aria-pressed={scoped}
                aria-label={t('Search only {scope}', { scope: scopeLabel.replace(/^In /, '') })}
                title={t('Search only {scope}', { scope: scopeLabel.replace(/^In /, '') })}
                className={`flex items-center gap-1 mr-1 pl-1.5 pr-2 py-0.5 rounded-full text-xs transition-colors flex-shrink-0 ${
                  scoped
                    ? 'bg-white text-black font-medium'
                    : 'bg-[#272727] text-[#aaa] hover:text-white hover:bg-[#3a3a3a]'
                }`}
              >
                <svg
                  className={`w-3 h-3 transition-opacity ${scoped ? 'opacity-100' : 'opacity-0'}`}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                {scopeLabel}
              </button>
            )}
            {searchQuery ? (
              <button
                onClick={() => onSearchChange?.('')}
                aria-label={t('Clear search')}
                className="px-2 text-[#aaa] hover:text-white"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            ) : (
              <span className="px-3 text-[#999]">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </span>
            )}
          </div>
        </div>

        {/* Right: the bell — on every page, because background work can finish
            while you are on any of them — plus the page's own action, which
            today only the Imported page has. */}
        <div className="flex items-center gap-1 px-4 flex-shrink-0">
          {onImport && (
            <button
              onClick={onImport}
              className="flex items-center gap-1.5 rounded-full bg-[#272727] px-3 py-1.5 text-sm text-white transition-colors hover:bg-[#3a3a3a]"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m-7-7h14" />
              </svg>
              <span className="hidden sm:inline">{t('Import')}</span>
            </button>
          )}
          <NotificationBell />
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
