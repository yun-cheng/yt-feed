import { useState, useEffect, useCallback } from 'react'
import type { VideoItem } from '../App'

type Playlist = { id: number; name: string; item_count: number; thumbnail_url: string }

// Tell the app a playlist changed so its nav counts / pages refresh.
function notifyChanged() {
  window.dispatchEvent(new Event('playlists-changed'))
}

const BookmarkIcon = ({ filled }: { filled: boolean }) => (
  <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
  </svg>
)

type Props = {
  video: VideoItem
  onBack: () => void
}

export default function SaveToPlaylist({ video, onBack }: Props) {
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [memberIds, setMemberIds] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [pl, mem] = await Promise.all([
        fetch('/api/playlists').then((r) => (r.ok ? r.json() : [])),
        fetch(`/api/playlists/containing/${video.youtube_id}`).then((r) => (r.ok ? r.json() : [])),
      ])
      setPlaylists(pl)
      setMemberIds(new Set(mem))
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [video.youtube_id])

  useEffect(() => { load() }, [load])

  const toggle = async (pid: number) => {
    const has = memberIds.has(pid)
    setMemberIds((prev) => { const n = new Set(prev); if (has) n.delete(pid); else n.add(pid); return n })
    setPlaylists((prev) => prev.map((p) => p.id === pid ? { ...p, item_count: p.item_count + (has ? -1 : 1) } : p))
    try {
      if (has) {
        await fetch(`/api/playlists/${pid}/items/${video.youtube_id}`, { method: 'DELETE' })
      } else {
        await fetch(`/api/playlists/${pid}/items`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(video),
        })
      }
      notifyChanged()
    } catch { /* ignore */ }
  }

  const createAndAdd = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      const res = await fetch('/api/playlists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      })
      const p = await res.json()
      await fetch(`/api/playlists/${p.id}/items`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(video),
      })
      notifyChanged()
      setNewName(''); setCreating(false)
      load()
    } catch { /* ignore */ }
  }

  return (
    <div className="w-[260px]" onClick={(e) => e.stopPropagation()}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={onBack} className="text-[#aaa] hover:text-white p-1 -ml-1" aria-label="Back">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm font-semibold text-white">Save to…</span>
      </div>

      {/* Playlists */}
      <div className="max-h-56 overflow-y-auto">
        {loading ? (
          <div className="px-4 py-3 text-sm text-[#aaa]">Loading…</div>
        ) : playlists.length === 0 ? (
          <div className="px-4 py-3 text-sm text-[#777]">No playlists yet</div>
        ) : (
          playlists.map((p) => (
            <button
              key={p.id}
              onClick={() => toggle(p.id)}
              className="w-full flex items-center gap-3 px-4 py-2 hover:bg-white/10 transition-colors text-left"
            >
              <div className="w-10 h-7 rounded bg-[#3a3a3a] overflow-hidden flex-shrink-0">
                {p.thumbnail_url && <img src={p.thumbnail_url} alt="" className="w-full h-full object-cover" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white truncate">{p.name}</div>
                <div className="text-[11px] text-[#888]">{p.item_count} videos</div>
              </div>
              <BookmarkIcon filled={memberIds.has(p.id)} />
            </button>
          ))
        )}
      </div>

      {/* Create */}
      <div className="border-t border-white/10 mt-1 pt-1">
        {creating ? (
          <div className="px-3 py-2 flex flex-col gap-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createAndAdd() }}
              placeholder="Playlist name"
              className="w-full bg-[#121212] border border-[#3a3a3a] rounded px-2 py-1.5 text-sm text-white outline-none focus:border-[#3ea6ff]"
            />
            <div className="flex justify-end gap-2 text-sm">
              <button onClick={() => { setCreating(false); setNewName('') }} className="px-3 py-1 text-[#aaa] hover:text-white">Cancel</button>
              <button onClick={createAndAdd} disabled={!newName.trim()} className="px-3 py-1 rounded-full bg-white text-black font-medium disabled:opacity-40">Create</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="w-full flex items-center gap-4 px-4 py-2.5 text-sm text-white hover:bg-white/10 transition-colors"
          >
            <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            New playlist
          </button>
        )}
      </div>
    </div>
  )
}
