import type { TagInfo, LabelCount } from '../App'

type Props = {
  tags: TagInfo[]
  selectedTags: string[]
  onToggleTag: (tag: string) => void
  onSetTags: (tags: string[]) => void
  page: 'feed' | 'channels' | 'channel' | 'watchlater' | 'downloads' | 'search' | 'playlists' | 'playlist'
  onPageChange: (p: 'feed' | 'channels' | 'channel' | 'watchlater' | 'downloads' | 'playlists') => void
  onHome: () => void
  onToggleCollapse: () => void
  onClearFilter: () => void
  collapsed: boolean
  watchLaterCount?: number
  downloadsCount?: number
  playlistsCount?: number
  tagFilteredCounts?: Map<string, number> | null
  hiddenCount?: number
  showHidden?: boolean
  onToggleShowHidden?: () => void
  contentMode?: 'videos' | 'shorts'
  onContentModeChange?: (mode: 'videos' | 'shorts') => void
  // Channel-page mode: replace the global taxonomy with this channel's own
  // video-title labels (see ChannelPage). Single-select filtering.
  channelMode?: boolean
  channelLabels?: LabelCount[] | null
  channelLabelsBuilding?: boolean
  channelLabelsProgress?: { done: number; total: number } | null
  channelHasTopics?: boolean
  selectedLabel?: string | null
  onToggleLabel?: (label: string) => void
}

// Sidebar sections, in render order. Keys match the `group` field the backend
// taxonomy assigns (app/routers/tags.py); a group with no matching tags is
// skipped, so this can list every section the taxonomy defines.
//
// Language leads (it cuts across everything), then the rest run chill → serious.
const GROUP_ORDER = [
  { key: 'Language', icon: '🌐' },
  { key: 'Entertainment', icon: '🎬' },
  { key: 'Music', icon: '🎵' },
  { key: 'Gaming', icon: '🎮' },
  { key: 'Sports', icon: '🏅' },
  { key: 'Lifestyle', icon: '☕' },
  { key: 'Tech', icon: '💻' },
  { key: 'Knowledge', icon: '📚' },
  { key: 'Society', icon: '🏛️' },
  { key: 'Other', icon: '🏷️' },
]

const HomeIcon = () => (
  <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
  </svg>
)

const ChannelsIcon = () => (
  <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/>
  </svg>
)

const WatchLaterIcon = () => (
  <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
  </svg>
)

const DownloadsIcon = () => (
  <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
  </svg>
)

const PlaylistsIcon = () => (
  <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <path d="M3 10h11v2H3v-2zm0-4h11v2H3V6zm0 8h7v2H3v-2zm13-1v8l6-4-6-4z"/>
  </svg>
)

const HamburgerButton = ({ onClick, className = '' }: { onClick: () => void; className?: string }) => (
  <button
    onClick={onClick}
    className={`text-[#aaa] hover:text-white transition-colors flex-shrink-0 ${className}`}
    aria-label="Toggle sidebar"
  >
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  </button>
)

const LogoMark = () => (
  <svg className="w-6 h-6 text-red-500 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0C.488 3.45.029 5.804 0 12c.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0C23.512 20.55 23.971 18.196 24 12c-.029-6.185-.484-8.549-4.385-8.816zM9 16V8l8 4-8 4z"/>
  </svg>
)

const ShortsIcon = () => (
  <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <path d="M10 8.64v6.72L15.27 12 10 8.64zM17.77 10.32c1.71.94 2.38 3.09 1.5 4.82-.34.67-.87 1.2-1.5 1.55l-6.9 3.8c-1.71.94-3.86.31-4.8-1.4-.94-1.71-.31-3.86 1.4-4.8l.4-.22-.4-.22c-1.71-.94-2.34-3.09-1.4-4.8.94-1.71 3.09-2.34 4.8-1.4l6.9 3.8z"/>
  </svg>
)

const VideosIcon = () => (
  <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <path d="M4 5a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2v-3l4 3V7l-4 3V7a2 2 0 00-2-2H4z"/>
  </svg>
)

const ContentModeToggle = ({ mode, onChange }: { mode: 'videos' | 'shorts'; onChange: (m: 'videos' | 'shorts') => void }) => (
  <div className="flex bg-[#272727] rounded-full p-0.5 text-sm">
    {(['videos', 'shorts'] as const).map((m) => (
      <button
        key={m}
        onClick={() => onChange(m)}
        className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-full transition-colors ${
          mode === m ? 'bg-white text-black font-medium' : 'text-[#aaa] hover:text-white'
        }`}
      >
        {m === 'videos' ? <VideosIcon /> : <ShortsIcon />}
        {m === 'videos' ? 'Videos' : 'Shorts'}
      </button>
    ))}
  </div>
)

const EyeIcon = () => (
  <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
  </svg>
)

const ToggleSwitch = ({ on }: { on: boolean }) => (
  <span className={`relative inline-block w-9 h-5 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-blue-500' : 'bg-[#3f3f3f]'}`}>
    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
  </span>
)

export default function Sidebar({ tags, selectedTags, onToggleTag, onSetTags, page, onPageChange, onHome, onToggleCollapse, onClearFilter, collapsed, watchLaterCount, downloadsCount, playlistsCount, tagFilteredCounts, hiddenCount, showHidden, onToggleShowHidden, contentMode = 'videos', onContentModeChange, channelMode, channelLabels, channelLabelsBuilding, channelLabelsProgress, channelHasTopics, selectedLabel, onToggleLabel }: Props) {
  const grouped = new Map<string, TagInfo[]>()
  for (const tag of tags) {
    const g = tag.group || '其他'
    if (!grouped.has(g)) grouped.set(g, [])
    grouped.get(g)!.push(tag)
  }

  if (collapsed) {
    return (
      <aside className="w-16 bg-[#0f0f0f] flex-shrink-0 flex flex-col h-full">
        {/* Menu toggle + logo */}
        <div className="flex flex-col items-center pt-2 gap-1 flex-shrink-0">
          <HamburgerButton onClick={onToggleCollapse} className="p-2" />
          <button
            onClick={onHome}
            className="flex items-center justify-center py-1 hover:opacity-80 transition-opacity"
            aria-label="My Feed"
          >
            <LogoMark />
          </button>
        </div>
        <nav className="flex flex-col items-center pt-2 gap-1">
          {onContentModeChange && (
            <button
              onClick={() => onContentModeChange(contentMode === 'shorts' ? 'videos' : 'shorts')}
              title={contentMode === 'shorts' ? 'Showing Shorts — switch to Videos' : 'Show Shorts'}
              className={`w-full flex flex-col items-center gap-0.5 py-3 transition-colors ${
                contentMode === 'shorts' ? 'text-white' : 'text-[#717171] hover:text-white'
              }`}
            >
              <ShortsIcon />
              <span className="text-[10px]">Shorts</span>
            </button>
          )}
          <button
            onClick={() => onPageChange('feed')}
            className={`w-full flex flex-col items-center gap-0.5 py-3 transition-colors ${
              page === 'feed' ? 'text-white' : 'text-[#717171] hover:text-white'
            }`}
          >
            <HomeIcon />
            <span className="text-[10px]">My Feed</span>
          </button>
          <button
            onClick={() => onPageChange('channels')}
            className={`w-full flex flex-col items-center gap-0.5 py-3 transition-colors ${
              page === 'channels' ? 'text-white' : 'text-[#717171] hover:text-white'
            }`}
          >
            <ChannelsIcon />
            <span className="text-[10px]">Channels</span>
          </button>
          <button
            onClick={() => onPageChange('watchlater')}
            className={`w-full flex flex-col items-center gap-0.5 py-3 transition-colors relative ${
              page === 'watchlater' ? 'text-white' : 'text-[#717171] hover:text-white'
            }`}
          >
            <WatchLaterIcon />
            <span className="text-[10px]">Later</span>
            {!!watchLaterCount && (
              <span className="absolute top-2 right-2.5 text-[9px] bg-blue-500 text-white rounded-full w-4 h-4 flex items-center justify-center font-bold">
                {watchLaterCount > 9 ? '9+' : watchLaterCount}
              </span>
            )}
          </button>
          <button
            onClick={() => onPageChange('downloads')}
            className={`w-full flex flex-col items-center gap-0.5 py-3 transition-colors relative ${
              page === 'downloads' ? 'text-white' : 'text-[#717171] hover:text-white'
            }`}
          >
            <DownloadsIcon />
            <span className="text-[10px]">Downloads</span>
            {!!downloadsCount && (
              <span className="absolute top-2 right-2.5 text-[9px] bg-blue-500 text-white rounded-full w-4 h-4 flex items-center justify-center font-bold">
                {downloadsCount > 9 ? '9+' : downloadsCount}
              </span>
            )}
          </button>
          <button
            onClick={() => onPageChange('playlists')}
            className={`w-full flex flex-col items-center gap-0.5 py-3 transition-colors relative ${
              page === 'playlists' || page === 'playlist' ? 'text-white' : 'text-[#717171] hover:text-white'
            }`}
          >
            <PlaylistsIcon />
            <span className="text-[10px]">Lists</span>
            {!!playlistsCount && (
              <span className="absolute top-2 right-2.5 text-[9px] bg-blue-500 text-white rounded-full w-4 h-4 flex items-center justify-center font-bold">
                {playlistsCount > 9 ? '9+' : playlistsCount}
              </span>
            )}
          </button>
          {!!hiddenCount && (
            <button
              onClick={onToggleShowHidden}
              title={showHidden ? 'Hiding hidden channels' : 'Show hidden channels'}
              className={`w-full flex flex-col items-center gap-0.5 py-3 transition-colors ${
                showHidden ? 'text-white' : 'text-[#717171] hover:text-white'
              }`}
            >
              <EyeIcon />
              <span className="text-[10px]">Hidden</span>
            </button>
          )}
        </nav>
      </aside>
    )
  }

  return (
    <aside className="w-60 bg-[#0f0f0f] flex-shrink-0 flex flex-col h-full">
      {/* Menu toggle + logo */}
      <div className="flex items-center gap-3 px-4 h-14 flex-shrink-0">
        <HamburgerButton onClick={onToggleCollapse} className="hidden md:block" />
        <button
          onClick={onHome}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <LogoMark />
          <span className="text-base font-semibold tracking-tight text-white">My Feed</span>
        </button>
      </div>

      {/* Videos ↔ Shorts: switches what the feed / channel pages show */}
      {onContentModeChange && (
        <div className="px-3 pb-2 flex-shrink-0">
          <ContentModeToggle mode={contentMode} onChange={onContentModeChange} />
        </div>
      )}

      {/* Nav: Feed, Channels — hidden on mobile (bottom bar handles navigation) */}
      <div className="py-2 hidden md:block">
        <button
          onClick={() => onPageChange('feed')}
          className={`w-full flex items-center gap-4 px-4 py-2.5 text-sm transition-colors ${
            page === 'feed'
              ? 'bg-[#272727] text-white font-medium'
              : 'text-[#aaa] hover:bg-[#1a1a1a] hover:text-white'
          }`}
        >
          <HomeIcon />
          My Feed
        </button>
        <button
          onClick={() => onPageChange('channels')}
          className={`w-full flex items-center gap-4 px-4 py-2.5 text-sm transition-colors ${
            page === 'channels'
              ? 'bg-[#272727] text-white font-medium'
              : 'text-[#aaa] hover:bg-[#1a1a1a] hover:text-white'
          }`}
        >
          <ChannelsIcon />
          Channels
        </button>
        <button
          onClick={() => onPageChange('watchlater')}
          className={`w-full flex items-center gap-4 px-4 py-2.5 text-sm transition-colors ${
            page === 'watchlater'
              ? 'bg-[#272727] text-white font-medium'
              : 'text-[#aaa] hover:bg-[#1a1a1a] hover:text-white'
          }`}
        >
          <WatchLaterIcon />
          Watch Later
          {!!watchLaterCount && (
            <span className="ml-auto text-xs bg-[#3a3a3a] text-[#aaa] rounded-full px-2 py-0.5 font-medium">
              {watchLaterCount}
            </span>
          )}
        </button>
        <button
          onClick={() => onPageChange('downloads')}
          className={`w-full flex items-center gap-4 px-4 py-2.5 text-sm transition-colors ${
            page === 'downloads'
              ? 'bg-[#272727] text-white font-medium'
              : 'text-[#aaa] hover:bg-[#1a1a1a] hover:text-white'
          }`}
        >
          <DownloadsIcon />
          Downloads
          {!!downloadsCount && (
            <span className="ml-auto text-xs bg-[#3a3a3a] text-[#aaa] rounded-full px-2 py-0.5 font-medium">
              {downloadsCount}
            </span>
          )}
        </button>
        <button
          onClick={() => onPageChange('playlists')}
          className={`w-full flex items-center gap-4 px-4 py-2.5 text-sm transition-colors ${
            page === 'playlists' || page === 'playlist'
              ? 'bg-[#272727] text-white font-medium'
              : 'text-[#aaa] hover:bg-[#1a1a1a] hover:text-white'
          }`}
        >
          <PlaylistsIcon />
          Playlists
          {!!playlistsCount && (
            <span className="ml-auto text-xs bg-[#3a3a3a] text-[#aaa] rounded-full px-2 py-0.5 font-medium">
              {playlistsCount}
            </span>
          )}
        </button>
      </div>

      <div className="border-t border-[#272727] mx-4 hidden md:block" />

      {/* Channel page: this channel's own topic labels (drawn from video titles),
          replacing the global taxonomy, which is meaningless when already scoped
          to one channel. */}
      {channelMode ? (
        <div className="p-4 flex-1 overflow-y-auto">
          <div className="flex items-center gap-1.5 mb-3 text-xs uppercase tracking-wider font-medium text-[#717171]">
            <span>🏷️</span>
            <span>Topics</span>
            {!!selectedLabel && (
              <button
                onClick={() => onToggleLabel?.(selectedLabel)}
                className="ml-auto text-[10px] normal-case tracking-normal font-normal text-[#717171] hover:text-white"
              >
                clear
              </button>
            )}
          </div>
          {channelLabels === null || channelLabels === undefined ? (
            <p className="text-xs text-[#555] animate-pulse">
              {channelLabelsBuilding
                ? channelLabelsProgress && channelLabelsProgress.total
                  ? `Finding topics… ${Math.floor((channelLabelsProgress.done / channelLabelsProgress.total) * 100)}%`
                  : 'Finding topics…'
                : 'Loading…'}
            </p>
          ) : channelLabels.length === 0 ? (
            <p className="text-xs text-[#555]">
              {channelHasTopics ? 'No topics in this time range.' : 'No topics found for this channel.'}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {channelLabels.map(({ name, count }) => {
                const active = selectedLabel === name
                return (
                  <button
                    key={name}
                    onClick={() => onToggleLabel?.(name)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 text-sm rounded-full transition-colors ${
                      active
                        ? 'bg-white text-black font-medium'
                        : 'bg-[#272727] text-[#ddd] hover:bg-[#3a3a3a]'
                    }`}
                  >
                    <span>{name}</span>
                    <span className={`text-[10px] ${active ? 'text-black/50' : 'text-[#555]'}`}>
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ) : (
      /* Tag groups */
      <div className="p-4 space-y-5 flex-1 overflow-y-auto">
        {!!hiddenCount && (
          <button
            onClick={onToggleShowHidden}
            className="w-full flex items-center gap-3 pb-4 border-b border-[#272727] text-left text-[#aaa] hover:text-white transition-colors"
          >
            <ToggleSwitch on={!!showHidden} />
            <span className="text-sm">Show hidden channels</span>
          </button>
        )}
        {GROUP_ORDER.map(({ key, icon }) => {
          const groupTags = grouped.get(key)
          if (!groupTags?.length) return null
          return (
            <div key={key}>
              {(() => {
                const groupNames = groupTags.map(t => t.name)
                const allSelected = groupNames.every(n => selectedTags.includes(n))
                const toggleGroup = () => {
                  if (allSelected) {
                    onSetTags(selectedTags.filter(t => !groupNames.includes(t)))
                  } else {
                    const toAdd = groupNames.filter(n => !selectedTags.includes(n))
                    onSetTags([...selectedTags, ...toAdd])
                  }
                }
                return (
                  <button
                    onClick={toggleGroup}
                    className={`flex items-center gap-1.5 mb-2 text-xs uppercase tracking-wider font-medium w-full text-left transition-colors rounded px-1 py-0.5 -mx-1 cursor-pointer ${
                      allSelected
                        ? 'text-white hover:bg-[#2a2a2a]'
                        : 'text-[#717171] hover:text-[#ccc] hover:bg-[#1e1e1e]'
                    }`}
                  >
                    <span>{icon}</span>
                    <span>{key}</span>
                    <span className="ml-auto text-[10px] opacity-40 normal-case tracking-normal font-normal">
                      {allSelected ? 'deselect all' : 'select all'}
                    </span>
                  </button>
                )
              })()}
              <div className="flex flex-wrap gap-1.5">
                {groupTags.map((tag) => {
                  const active = selectedTags.includes(tag.name)
                  return (
                    <button
                      key={tag.name}
                      onClick={() => onToggleTag(tag.name)}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-sm rounded-full transition-colors ${
                        active
                          ? 'bg-white text-black font-medium'
                          : 'bg-[#272727] text-[#ddd] hover:bg-[#3a3a3a]'
                      }`}
                    >
                      <span>{tag.icon}</span>
                      <span>{tag.name}</span>
                      <span className={`text-[10px] ${active ? 'text-black/50' : 'text-[#555]'}`}>
                        {tagFilteredCounts ? (tagFilteredCounts.get(tag.name) ?? 0) : tag.channel_count}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      )}
    </aside>
  )
}
