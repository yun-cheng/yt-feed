import type { TagInfo } from '../App'

type Props = {
  tags: TagInfo[]
  selectedTags: string[]
  onToggleTag: (tag: string) => void
}

const GROUP_ORDER = [
  { key: '開發', label: '開發', icon: '⚙️' },
  { key: '語言', label: '語言', icon: '🌐' },
  { key: '音樂', label: '音樂', icon: '🎵' },
  { key: '財經', label: '財經', icon: '📈' },
  { key: '知識', label: '知識', icon: '📚' },
  { key: '生活', label: '生活', icon: '☕' },
  { key: '娛樂', label: '娛樂', icon: '🎬' },
  { key: '其他', label: '其他', icon: '🏷️' },
]

export default function Sidebar({ tags, selectedTags, onToggleTag }: Props) {
  // Group tags
  const grouped = new Map<string, TagInfo[]>()
  for (const tag of tags) {
    const g = tag.group || '其他'
    if (!grouped.has(g)) grouped.set(g, [])
    grouped.get(g)!.push(tag)
  }

  const totalChannels = tags.reduce((s, t) => s + t.channel_count, 0)

  return (
    <aside className="w-72 bg-[#0f0f0f] border-r border-[#272727] flex-shrink-0 overflow-y-auto">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-[#272727]">
        <h1 className="text-lg font-semibold tracking-tight flex items-center gap-2">
          <svg className="w-6 h-6 text-red-500" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0C.488 3.45.029 5.804 0 12c.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0C23.512 20.55 23.971 18.196 24 12c-.029-6.185-.484-8.549-4.385-8.816zM9 16V8l8 4-8 4z"/>
          </svg>
          Feed
          <span className="ml-auto text-xs text-[#555]">{totalChannels}</span>
        </h1>
      </div>

      <div className="p-4 space-y-5">
        {/* All button */}
        <button
          onClick={() => selectedTags.length > 0 && window.location.reload()}
          className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
            selectedTags.length === 0
              ? 'bg-[#272727] text-white font-medium'
              : 'text-[#aaaaaa] hover:bg-[#222]'
          }`}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
          </svg>
          All
          <span className="ml-auto text-xs text-[#555]">{totalChannels}</span>
        </button>

        {/* Grouped tag chips */}
        {GROUP_ORDER.map(({ key, label, icon }) => {
          const groupTags = grouped.get(key)
          if (!groupTags?.length) return null
          return (
            <div key={key}>
              <div className="flex items-center gap-1.5 mb-2 text-xs text-[#717171] uppercase tracking-wider font-medium">
                <span>{icon}</span>
                <span>{label}</span>
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