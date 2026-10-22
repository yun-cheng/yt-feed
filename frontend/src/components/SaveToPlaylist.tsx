import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../lib/api'
import type { VideoItem } from '../App'
import { tn, t } from '../lib/i18n'

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
  // Narrows the list by name, for when there are more playlists than fit.
  const [query, setQuery] = useState('')
  const queryRef = useRef<HTMLInputElement>(null)
  // Focused on open, so you can type a name straight away; without scrolling,
  // since the menu around it may not be placed yet.
  useEffect(() => { queryRef.current?.focus({ preventScroll: true }) }, [])
  const q = query.trim().toLocaleLowerCase()
  const shown = q ? playlists.filter((p) => p.name.toLocaleLowerCase().includes(q)) : playlists
  // The list's height with nothing typed, held while a search narrows it, so
  // the menu doesn't shrink under the pointer (or hop, placed above the button)
  // with each letter.
  const listRef = useRef<HTMLDivElement>(null)
  const [fullHeight, setFullHeight] = useState<number>()
  useLayoutEffect(() => {
    if (!loading && !q && listRef.current) setFullHeight(listRef.current.offsetHeight)
  }, [loading, q, playlists])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [pl, mem] = await Promise.all([
        apiFetch('/api/playlists').then((r) => (r.ok ? r.json() : [])),
        apiFetch(`/api/playlists/containing/${video.youtube_id}`).then((r) => (r.ok ? r.json() : [])),
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
        await apiFetch(`/api/playlists/${pid}/items/${video.youtube_id}`, { method: 'DELETE' })
      } else {
        await apiFetch(`/api/playlists/${pid}/items`, {
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
      const res = await apiFetch('/api/playlists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      })
      const p = await res.json()
      await apiFetch(`/api/playlists/${p.id}/items`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(video),
      })
      notifyChanged()
      setNewName(''); setCreating(false)
      load()
    } catch { /* ignore */ }
  }

  return (
    // A column, so when the menu around it is capped to the window
    // (lib/popover.ts) the playlist list gives up the height and the header
    // and New playlist stay in view.
    <div className="flex min-h-0 w-[260px] flex-col" onClick={(e) => e.stopPropagation()}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={onBack} className="text-shade-aa hover:text-white p-1 -ml-1" aria-label={t('Back')}>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm font-semibold text-white">{t('Save to…')}</span>
      </div>

      {/* Filter */}
      <div className="relative px-3 pb-2">
        <svg className="pointer-events-none absolute left-5 top-[calc(50%-0.25rem)] h-4 w-4 -translate-y-1/2 text-shade-99" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="11" cy="11" r="7" />
          <path strokeLinecap="round" d="M20 20l-3.5-3.5" />
        </svg>
        <input
          ref={queryRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter saves to the one playlist left, if it's come down to one.
            if (e.key === 'Enter' && q && shown.length === 1) toggle(shown[0].id)
            // Esc clears; on an empty field it gives the keyboard back.
            if (e.key !== 'Escape') return
            e.stopPropagation()
            if (query) setQuery('')
            else e.currentTarget.blur()
          }}
          placeholder={t('Search playlists')}
          aria-label={t('Search playlists')}
          className="w-full rounded-full bg-shade-12 py-1.5 pl-8 pr-8 text-sm text-white ring-1 ring-white/10 placeholder:text-shade-88 focus:outline-none focus:ring-white/25"
        />
        {query && (
          <button
            onClick={() => { setQuery(''); queryRef.current?.focus() }}
            aria-label={t('Clear search')}
            className="absolute right-4 top-[calc(50%-0.25rem)] -translate-y-1/2 rounded-full p-1 text-shade-99 transition-colors hover:bg-white/10 hover:text-white"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>

      {/* Playlists */}
      <div
        ref={listRef}
        style={{ minHeight: q ? fullHeight : undefined }}
        className="max-h-[26rem] min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {loading ? (
          <div className="px-4 py-3 text-sm text-shade-aa">{t('Loading…')}</div>
        ) : playlists.length === 0 ? (
          <div className="px-4 py-3 text-sm text-shade-99">{t('No playlists yet')}</div>
        ) : shown.length === 0 ? (
          <div className="px-4 py-3 text-sm text-shade-99">{t('No playlists match “{q}”.', { q: query.trim() })}</div>
        ) : (
          shown.map((p) => (
            <button
              key={p.id}
              onClick={() => toggle(p.id)}
              className="w-full flex items-center gap-3 px-4 py-2 hover:bg-white/10 transition-colors text-left"
            >
              <div className="w-10 h-7 rounded bg-shade-3a overflow-hidden flex-shrink-0">
                {p.thumbnail_url && <img src={p.thumbnail_url} alt="" className="w-full h-full object-cover" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white truncate">{p.name}</div>
                <div className="text-[11px] text-shade-99">{tn(p.item_count, '{n} video', '{n} videos')}</div>
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
              placeholder={t('Playlist name')}
              className="w-full bg-shade-12 border border-shade-3a rounded px-2 py-1.5 text-sm text-white outline-none focus:border-tint-3ea6ff"
            />
            <div className="flex justify-end gap-2 text-sm">
              <button onClick={() => { setCreating(false); setNewName('') }} className="px-3 py-1 text-shade-aa hover:text-white">Cancel</button>
              <button onClick={createAndAdd} disabled={!newName.trim()} className="px-3 py-1 rounded-full bg-white text-black font-medium disabled:opacity-40">{t('Create')}</button>
            </div>
          </div>
        ) : (
          <button
            // A search that found nothing is likely the name you wanted.
            onClick={() => { setNewName(shown.length ? '' : query.trim()); setCreating(true) }}
            className="w-full flex items-center gap-4 px-4 py-2.5 text-sm text-white hover:bg-white/10 transition-colors"
          >
            <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            {t('New playlist')}
          </button>
        )}
      </div>
    </div>
  )
}
