import { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import VideoRow from './components/VideoRow'

export type VideoItem = {
  youtube_id: string
  title: string
  channel_id: string
  channel_name?: string
  thumbnail_url: string
  published_at: string
  view_count: number
  like_count: number
  duration_seconds: number
  score: number
}

export type TagInfo = {
  name: string
  group: string
  icon: string
  channel_count: number
}

export type FeedGroup = {
  name: string
  icon: string
  sort_order: number
  videos: VideoItem[]
}

export type FeedResponse = {
  categories: { name: string; icon: string; sort_order: number }[]
  groups: FeedGroup[]
  window: string
}

export default function App() {
  const [feed, setFeed] = useState<FeedResponse | null>(null)
  const [tags, setTags] = useState<TagInfo[]>([])
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [window, setWindow] = useState('1w')

  useEffect(() => {
    fetchTags()
    fetchFeed()
  }, [window, selectedTags])

  async function fetchTags() {
    try {
      const res = await fetch('/api/tags')
      setTags(await res.json())
    } catch (e) {
      console.error('Failed to fetch tags:', e)
    }
  }

  async function fetchFeed() {
    setLoading(true)
    try {
      const params = new URLSearchParams({ window })
      if (selectedTags.length > 0) {
        params.set('tags', selectedTags.join(','))
      }
      // Use tag feed endpoint when tags are selected, else use old feed
      const url = selectedTags.length > 0
        ? `/api/tags/feed?${params}`
        : `/api/feed?${params}`
      const res = await fetch(url)
      const data = await res.json()

      if (selectedTags.length > 0) {
        // Wrap tag feed results in a single group
        setFeed({
          categories: [],
          groups: [{
            name: selectedTags.map(t => tags.find(ti => ti.name === t)?.icon || t).join(' + '),
            icon: '',
            sort_order: 0,
            videos: data.videos || [],
          }],
          window: data.window,
        })
      } else {
        setFeed(data)
      }
    } catch (e) {
      console.error('Failed to fetch feed:', e)
    }
    setLoading(false)
  }

  function toggleTag(tag: string) {
    setSelectedTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    )
  }

  async function refreshFeed() {
    await fetchFeed()
    await fetchTags()
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        tags={tags}
        selectedTags={selectedTags}
        onToggleTag={toggleTag}
      />

      <main className="flex-1 overflow-y-auto">
        <TopBar
          window={window}
          onWindowChange={setWindow}
          onRefresh={refreshFeed}
        />

        <div className="px-6 py-4">
          {!feed ? (
            loading ? (
              <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
                Loading feed...
              </div>
            ) : (
              <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
                No data yet.
              </div>
            )
          ) : feed.groups.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-[#aaaaaa]">
              No videos found.
            </div>
          ) : (
            feed.groups.map((group) => (
              <VideoRow key={group.name} group={group} />
            ))
          )}
        </div>
      </main>
    </div>
  )
}