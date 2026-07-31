import { useState } from 'react'
import { apiFetch } from '../lib/api'
import type { LocalFolder } from '../lib/local'

type Props = {
  folders: LocalFolder[]
  onOpen: (folderId: number) => void
  onAdd: (path: string) => Promise<string | null>  // resolves to an error message, or null
  onRemove: (folderId: number) => void
}

/** The list of local folders, and the box for adding one.
 *
 * The path is typed rather than picked: the folder is read by the BACKEND, which
 * may not even be on this machine, so a browser file picker would hand us a
 * sandboxed handle the server can't open. What the server needs is a path in its
 * own filesystem, and that's what this asks for.
 */
export default function LocalPage({ folders, onOpen, onAdd, onRemove }: Props) {
  const [path, setPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!path.trim() || adding) return
    setAdding(true)
    setError('')
    const err = await onAdd(path.trim())
    setAdding(false)
    if (err) setError(err)
    else setPath('')
  }

  return (
    <div className="px-6 py-4">
      <div className="max-w-[900px]">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-white">Local folders</h2>
          <p className="mt-1 text-sm text-[#717171]">
            Point this at a directory on the machine running the backend and its videos
            show up here as a feed. Files are only ever read — removing a folder from
            this list never touches what's on disk.
          </p>
        </div>

        <div className="mb-8 flex flex-col gap-2 sm:flex-row">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            placeholder="/Users/you/Movies/lessons"
            spellCheck={false}
            className="flex-1 rounded-lg border border-[#303030] bg-[#121212] px-3 py-2 text-sm text-white placeholder:text-[#555] focus:border-[#3ea6ff] focus:outline-none"
          />
          <button
            onClick={submit}
            disabled={adding || !path.trim()}
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-80 disabled:opacity-40"
          >
            {adding ? 'Scanning…' : 'Add folder'}
          </button>
        </div>
        {error && <p className="-mt-6 mb-8 text-sm text-red-400">{error}</p>}

        {folders.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-[#aaa]">
            <svg className="h-12 w-12 text-[#444]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            </svg>
            <p className="text-sm">No local folders yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {folders.map((f) => (
              <div
                key={f.id}
                onClick={() => onOpen(f.id)}
                className="group flex cursor-pointer items-center gap-4 rounded-xl border border-[#272727] bg-[#121212] px-4 py-3 transition-colors hover:bg-[#1c1c1c]"
              >
                <svg className="h-8 w-8 flex-shrink-0 text-[#3ea6ff]" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                </svg>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-white">{f.name}</span>
                    {!f.available && (
                      <span className="flex-shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300">
                        unavailable
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-[#717171]" title={f.path}>{f.path}</div>
                </div>
                <span className="flex-shrink-0 text-sm text-[#aaa]">
                  {f.video_count} video{f.video_count === 1 ? '' : 's'}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(f.id) }}
                  title="Remove this folder from the app (the files stay)"
                  className="flex-shrink-0 rounded p-1.5 text-[#717171] opacity-0 transition-all hover:bg-[#272727] hover:text-white group-hover:opacity-100"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Add a folder by path. Returns an error message, or null on success. */
export async function addLocalFolder(path: string): Promise<string | null> {
  try {
    const res = await apiFetch('/api/local/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
      // The path is user-typed, so a rejection is expected input, not a fault —
      // it's reported inline under the box instead of as a toast.
      quiet: true,
    })
    if (res.ok) return null
    const data = await res.json().catch(() => null)
    return data?.detail || `Could not add that folder (${res.status})`
  } catch {
    return 'Could not reach the backend'
  }
}
