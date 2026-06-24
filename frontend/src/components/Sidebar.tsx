import type { TagInfo } from '../App'

type Props = {
  tags: TagInfo[]
  selectedTags: string[]
  onToggleTag: (tag: string) => void
  page: 'feed' | 'channels' | 'channel'
  onPageChange: (p: 'feed' | 'channels' | 'channel') => void
  onClearFilter: () => void
  onHome: () => void
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

export default function Sidebar({ tags, selectedTags, onToggleTag, page, onPageChange, onClearFilter, onHome }: Props) {
  const grouped = new Map<string, TagInfo[]>()
  for (const tag of tags) {
    const g = tag.group || '其他'
    if (!grouped.has(g)) grouped.set(g, [])
    grouped.get(g)!.push(tag)
  }

  const totalChannels = tags.reduce((s, t) => s + t.channel_count, 0)

  return (
    <aside className="w-60 bg-[#0f0f0f] border-r border-[#272727] flex-shrink-0 overflow-y-auto">
      {/* Logo + page pills */}
      <div className="px-4 py-4 border-b border-[#272727]">
        <div className="flex items-center justify-between">
          <button
            onClick={() => { onHome(); onPageChange('feed'); onClearFilter() }}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <svg className="w-6 h-6 text-red-500" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0C.488 3.45.029 5.804 0 12c.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0C23.512 20.55 23.971 18.196 24 12c-.029-6.185-.484-8.549-4.385-8.816zM9 16V8l8 4-8 4z"/>
            </svg>
            <span className="text-lg font-semibold tracking-tight">Home</span>
          </button>
          <div className="flex gap-1 bg-[#1a1a1a] rounded-lg p-0.5">
            <button
              onClick={() => onPageChange('feed')}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                page === 'feed'
                  ? 'bg-[#272727] text-white font-medium'
                  : 'text-[#888] hover:text-white'
                }`}
              >
                Feed
            </button>
            <button
              onClick={() => onPageChange('channels')}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                page === 'channels'
                  ? 'bg-[#272727] text-white font-medium'
                  : 'text-[#888] hover:text-white'
              }`}
            >
              Channels
            </button>
          </div>
        </div>
      </div>

      <div className="p-4 space-y-5">
        {/* Grouped tag chips */}
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