import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../lib/api'

export type YouTubePlaylist = {
  youtube_id: string
  title: string
  description: string
  thumbnail_url: string
  item_count: number
  // The local playlist this one has already been brought into, if any. What
  // turns a second click into a re-sync rather than a duplicate.
  linked_id: number | null
  // Only on a looked-up playlist: who owns it. The list below is all yours, so
  // there'd be nothing to say.
  channel_name?: string
}

type Props = {
  onClose: () => void
  // Fired after anything lands, so the page behind can reload its list.
  onImported: (playlistId: number) => void
}

/**
 * Bring a YouTube playlist over.
 *
 * Lists what the connected YouTube account created, and copies one here on
 * click. Deliberately not a mirror: the copy keeps a link back, a re-sync pulls
 * anything new, and nothing here ever deletes from the copy — so clicking again
 * is always safe.
 *
 * The list below is what this account CREATED — YouTube offers no way to
 * enumerate the playlists you saved from other people. So there's a paste box
 * above it: any public playlist can be read by id, it just can't be listed. What
 * neither reaches is a *private* playlist of someone else's, or Watch Later and
 * Liked Videos, which YouTube stopped serving over the API in 2016 — the
 * extension reads those off the page, so the footer points at it.
 */
export default function ImportPlaylistDialog({ onClose, onImported }: Props) {
  const [lists, setLists] = useState<YouTubePlaylist[] | null>(null)
  const [error, setError] = useState('')
  // Which row is mid-flight, so only its own button spins.
  const [busy, setBusy] = useState('')
  // The paste box: what's typed, and what looking it up found.
  const [ref, setRef] = useState('')
  const [found, setFound] = useState<YouTubePlaylist | null>(null)
  const [looking, setLooking] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const look = async () => {
    if (!ref.trim() || looking) return
    setLooking(true)
    setError('')
    setFound(null)
    try {
      const res = await apiFetch(`/api/playlists/youtube/lookup?ref=${encodeURIComponent(ref.trim())}`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.detail || 'Could not look that up.'); return }
      setFound(body)
    } catch {
      setError('Could not reach the app.')
    } finally {
      setLooking(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await apiFetch('/api/playlists/youtube')
        if (!alive) return
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          setError(body.detail || 'Could not reach YouTube.')
          setLists([])
          return
        }
        setLists(await res.json())
      } catch {
        if (alive) { setError('Could not reach the app.'); setLists([]) }
      }
    })()
    return () => { alive = false }
  }, [])

  const bring = async (p: YouTubePlaylist) => {
    if (busy) return
    setBusy(p.youtube_id)
    setError('')
    try {
      const res = await apiFetch('/api/playlists/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtube_id: p.youtube_id, name: p.title }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.detail || 'Import failed.'); return }
      // Reflect the new link in place — you may want to import several, and a
      // dialog that closed after each would make that four round trips.
      setLists((cur) => cur?.map((row) =>
        row.youtube_id === p.youtube_id ? { ...row, linked_id: body.id } : row
      ) ?? cur)
      setFound((cur) =>
        cur && cur.youtube_id === p.youtube_id ? { ...cur, linked_id: body.id } : cur
      )
      onImported(body.id)
    } catch {
      setError('Could not reach the app.')
    } finally {
      setBusy('')
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 p-4 pt-20"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-lg flex-col rounded-xl bg-[#212121] p-5 shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-medium text-white">Import from YouTube</h2>
        <p className="mt-1 text-xs text-[#888]">
          Copies a playlist here and remembers where it came from. Re-syncing only ever adds —
          nothing you keep here is removed.
        </p>

        <div className="mt-3 flex gap-2">
          <input
            ref={inputRef}
            value={ref}
            onChange={(e) => { setRef(e.target.value); setFound(null); setError('') }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); look() } }}
            placeholder="Paste any playlist link — including someone else's"
            className="min-w-0 flex-1 rounded-lg bg-[#121212] px-3 py-2 text-sm text-white placeholder-[#555] outline-none ring-1 ring-[#303030] focus:ring-[#3ea6ff]"
          />
          <button
            onClick={look}
            disabled={!ref.trim() || looking}
            className="flex-shrink-0 rounded-full bg-[#272727] px-4 py-1.5 text-sm text-white transition-colors hover:bg-[#3a3a3a] disabled:opacity-40"
          >
            {looking ? '…' : 'Look up'}
          </button>
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        {found && (
          <div className="mt-3 flex items-center gap-3 rounded-lg bg-[#181818] p-2 ring-1 ring-[#3ea6ff]/40">
            <div className="h-11 w-20 flex-shrink-0 overflow-hidden rounded bg-[#272727]">
              {found.thumbnail_url && (
                <img src={found.thumbnail_url} alt="" className="h-full w-full object-cover" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm text-white">{found.title}</h3>
              <p className="truncate text-xs text-[#777]">
                {found.item_count} {found.item_count === 1 ? 'video' : 'videos'}
                {found.channel_name ? ` · ${found.channel_name}` : ''}
              </p>
            </div>
            <button
              onClick={() => bring(found)}
              disabled={!!busy}
              className={
                found.linked_id
                  ? 'flex-shrink-0 rounded-full bg-[#272727] px-3 py-1.5 text-xs text-white transition-colors hover:bg-[#3a3a3a] disabled:opacity-40'
                  : 'flex-shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-[#ddd] disabled:opacity-40'
              }
            >
              {busy === found.youtube_id ? '…' : found.linked_id ? 'Re-sync' : 'Import'}
            </button>
          </div>
        )}

        <p className="mt-4 text-xs font-medium text-[#888]">Playlists you made</p>

        <div className="-mx-1 mt-2 min-h-0 flex-1 overflow-y-auto px-1">
          {lists === null ? (
            <p className="py-6 text-center text-xs text-[#666]">Asking YouTube…</p>
          ) : lists.length === 0 ? (
            !error && <p className="py-6 text-center text-xs text-[#666]">No playlists on that account.</p>
          ) : (
            <ul className="space-y-2">
              {lists.map((p) => (
                <li key={p.youtube_id} className="flex items-center gap-3 rounded-lg bg-[#181818] p-2 ring-1 ring-[#303030]">
                  <div className="h-11 w-20 flex-shrink-0 overflow-hidden rounded bg-[#272727]">
                    {p.thumbnail_url && (
                      <img src={p.thumbnail_url} alt="" className="h-full w-full object-cover" loading="lazy" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm text-white">{p.title}</h3>
                    <p className="text-xs text-[#777]">
                      {p.item_count} {p.item_count === 1 ? 'video' : 'videos'}
                    </p>
                  </div>
                  <button
                    onClick={() => bring(p)}
                    disabled={!!busy}
                    className={
                      p.linked_id
                        ? 'flex-shrink-0 rounded-full bg-[#272727] px-3 py-1.5 text-xs text-white transition-colors hover:bg-[#3a3a3a] disabled:opacity-40'
                        : 'flex-shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-[#ddd] disabled:opacity-40'
                    }
                  >
                    {busy === p.youtube_id ? '…' : p.linked_id ? 'Re-sync' : 'Import'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="mt-4 border-t border-[#303030] pt-3 text-xs leading-relaxed text-[#666]">
          Only playlists you made can be listed — paste a link for anyone else's. Watch Later,
          Liked Videos and other people's <em>private</em> playlists can't be read this way at all;
          open one on youtube.com and use the extension's
          <span className="text-[#888]"> Import to YT Feed </span> button, which reads the page as you.
        </p>

        <div className="mt-3 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-full px-4 py-1.5 text-sm text-[#aaa] transition-colors hover:bg-white/10 hover:text-white"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
