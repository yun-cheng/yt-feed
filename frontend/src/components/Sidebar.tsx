import type { TagInfo } from '../App'

type Props = {
  tags: TagInfo[]
  selectedTags: string[]
  onToggleTag: (tag: string) => void
  page: 'feed' | 'channels' | 'channel'
  onPageChange: (p: 'feed' | 'channels' | 'channel') => void
  onClearFilter: () => void
  onHome: () => void
  collapsed: boolean
  onToggleCollapse: () => void
}

const GROUP_NAMES: Record<string, string> = {
  '開發': 'Dev',
  '語言': 'Language',
  '音樂': 'Music',
  '財經': 'Finance',
  '知識': 'Knowledge',
  '生活': 'Lifestyle',
  '娛樂': 'Entertainment',
  '其他': 'Other',
}

const GROUP_ORDER = [
  { key: '開發', icon: '⚙️' },
  { key: '語言', icon: '🌐' },
  { key: '音樂', icon: '🎵' },
  { key: '財經', icon: '📈' },
  { key: '知識', icon: '📚' },
  { key: '生活', icon: '☕' },
  { key: '娛樂', icon: '🎬' },
  { key: '其他', icon: '🏷️' },
]

const YoutubeIcon = () => (
  <svg className="w-6 h-6 text-red-500 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0C.488 3.45.029 5.804 0 12c.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0C23.512 20.55 23.971 18.196 24 12c-.029-6.185-.484-8.549-4.385-8.816zM9 16V8l8 4-8 4z"/>
  </svg>
)

const FeedIcon = () => (
  <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <path d="M4 5h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4zM4 11h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4zM4 17h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4z"/>
  </svg>
)

const ChannelsIcon = () => (
  <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <path d="M3 5h18v2H3zm0 6h18v2H3zm0 6h18v2H3z"/>
  </svg>
)

export default function Sidebar({ tags, selectedTags, onToggleTag, page, onPageChange, onClearFilter, onHome, collapsed, onToggleCollapse }: Props) {
  const grouped = new Map<string, TagInfo[]>()
  for (const tag of tags) {
    const g = tag.group || '其他'
    if (!grouped.has(g)) grouped.set(g, [])
    grouped.get(g)!.push(tag)
  }

  if (collapsed) {
    return (
      <aside className="w-16 bg-[#0f0f0f] border-r border-[#272727] flex-shrink-0 flex flex-col h-full transition-[width] duration-200">
        <div className="flex flex-col items-center pt-3 pb-2 gap-1">
          {/* Expand toggle */}
          <button
            onClick={onToggleCollapse}
            className="w-full flex justify-center py-2 text-xs text-[#555] hover:text-white transition-colors font-mono"
          >
            {'>>'}
          </button>
          {/* Home */}
          <button
            onClick={() => { onHome(); onPageChange('feed'); onClearFilter() }}
            className="w-full flex justify-center py-2 hover:opacity-80 transition-opacity"
            title="Home"
          >
            <YoutubeIcon />
          </button>
          {/* Feed */}
          <button
            onClick={() => onPageChange('feed')}
            className={`w-full flex justify-center py-2 transition-colors ${
              page === 'feed' ? 'text-white' : 'text-[#717171] hover:text-white'
            }`}
            title="Feed"
          >
            <FeedIcon />
          </button>
          {/* Channels */}
          <button
            onClick={() => onPageChange('channels')}
            className={`w-full flex justify-center py-2 transition-colors ${
              page === 'channels' ? 'text-white' : 'text-[#717171] hover:text-white'
            }`}
            title="Channels"
          >
            <ChannelsIcon />
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="w-60 bg-[#0f0f0f] border-r border-[#272727] flex-shrink-0 flex flex-col h-full transition-[width] duration-200">
      {/* Home logo row + collapse button */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#272727]">
        <button
          onClick={() => { onHome(); onPageChange('feed'); onClearFilter() }}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <YoutubeIcon />
          <span className="text-base font-semibold tracking-tight">Home</span>
        </button>
        <button
          onClick={onToggleCollapse}
          className="text-xs text-[#555] hover:text-white transition-colors px-1 py-1 font-mono"
        >
          {'<<'}
        </button>
      </div>

      {/* Nav: Feed, Channels */}
      <div className="py-2">
        <button
          onClick={() => onPageChange('feed')}
          className={`w-full flex items-center gap-4 px-4 py-2.5 text-sm transition-colors ${
            page === 'feed'
              ? 'bg-[#272727] text-white font-medium'
              : 'text-[#aaa] hover:bg-[#1a1a1a] hover:text-white'
          }`}
        >
          <FeedIcon />
          Feed
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
      </div>

      <div className="border-t border-[#272727] mx-4" />

      {/* Tag groups */}
      <div className="p-4 space-y-5 flex-1 overflow-y-auto">
        {GROUP_ORDER.map(({ key, icon }) => {
          const groupTags = grouped.get(key)
          if (!groupTags?.length) return null
          return (
            <div key={key}>
              <div className="flex items-center gap-1.5 mb-2 text-xs text-[#717171] uppercase tracking-wider font-medium">
                <span>{icon}</span>
                <span>{GROUP_NAMES[key] || key}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {groupTags.map((tag) => {
                  const active = selectedTags.includes(tag.name)
                  return (
                    <button
                      key={tag.name}
                      onClick={() => onToggleTag(tag.name)}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full transition-colors ${
                        active
                          ? 'bg-white text-black font-medium'
                          : 'bg-[#272727] text-[#ddd] hover:bg-[#3a3a3a]'
                      }`}
                    >
                      <span>{tag.icon}</span>
                      <span>{tag.name}</span>
                      <span className={`text-[10px] ${active ? 'text-black/50' : 'text-[#555]'}`}>
                        {tag.channel_count}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
