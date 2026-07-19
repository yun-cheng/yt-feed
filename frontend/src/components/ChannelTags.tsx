import { useState, useEffect, useRef, useMemo } from 'react'
import { apiFetch } from '../lib/api'

type TagMeta = { name: string; group: string; icon: string; channel_count: number }

type Props = {
  channelId: string
  tags: string[]
  suggested: string[]
  onChange: (next: { tags: string[]; suggested: string[] }) => void
}

/**
 * The channel's labels: applied ones (removable) and suggested ones (one click
 * to add), plus a picker for any label in the taxonomy.
 *
 * Removing a label demotes it back to a suggestion rather than hiding it, so
 * nothing the backend derived is ever lost — you can always put it back.
 */
export default function ChannelTags({ channelId, tags, suggested, onChange }: Props) {
  const [allTags, setAllTags] = useState<TagMeta[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  // The full taxonomy — include_empty, because the sidebar list only carries
  // tags someone already has, and you must be able to add one nobody has yet.
  useEffect(() => {
    apiFetch('/api/tags?include_empty=true')
      .then((r) => r.json())
      .then(setAllTags)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [pickerOpen])

  const iconFor = useMemo(() => {
    const m = new Map(allTags.map((t) => [t.name, t.icon]))
    return (n: string) => m.get(n) ?? '🏷️'
  }, [allTags])

  const send = async (tag: string, method: 'POST' | 'DELETE') => {
    setBusy(tag)
    try {
      const res = await apiFetch(`/api/tags/${channelId}/tag/${encodeURIComponent(tag)}`, { method })
      if (!res.ok) return
      const d = await res.json()
      onChange({
        tags: method === 'POST' ? [...tags, tag].sort() : tags.filter((t) => t !== tag),
        suggested: d.suggested ?? suggested,
      })
    } catch {
      /* leave state as-is on failure */
    } finally {
      setBusy(null)
    }
  }

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = new Map<string, TagMeta[]>()
    for (const t of allTags) {
      if (tags.includes(t.name)) continue
      if (q && !t.name.toLowerCase().includes(q)) continue
      out.set(t.group, [...(out.get(t.group) ?? []), t])
    }
    return [...out.entries()]
  }, [allTags, tags, query])

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2">
      {tags.map((tag) => (
        <span
          key={tag}
          className="group flex items-center gap-1 pl-2 pr-1 py-0.5 text-[11px] bg-[#272727] text-[#ccc] rounded-full"
        >
          <span>{iconFor(tag)}</span>
          {tag}
          <button
            onClick={() => send(tag, 'DELETE')}
            disabled={busy === tag}
            title={`Remove ${tag}`}
            className="w-3.5 h-3.5 flex items-center justify-center rounded-full text-[#777] hover:text-white hover:bg-[#444] transition-colors disabled:opacity-40"
          >
            ×
          </button>
        </span>
      ))}

      {suggested.map((tag) => (
        <button
          key={tag}
          onClick={() => send(tag, 'POST')}
          disabled={busy === tag}
          title={`Add ${tag}`}
          className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full border border-dashed border-[#444] text-[#777] hover:text-[#ccc] hover:border-[#666] transition-colors disabled:opacity-40"
        >
          <span>{iconFor(tag)}</span>
          {tag}
          <span className="text-[#555]">+</span>
        </button>
      ))}

      <div className="relative" ref={pickerRef}>
        <button
          onClick={() => setPickerOpen((o) => !o)}
          className="px-2 py-0.5 text-[11px] rounded-full text-[#777] hover:text-[#ccc] hover:bg-[#272727] transition-colors"
        >
          + Add label
        </button>

        {pickerOpen && (
          <div className="absolute left-0 top-full mt-1 z-30 w-60 max-h-72 overflow-y-auto overscroll-contain rounded-xl border border-[#333] bg-[#1a1a1a] p-2 shadow-xl">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search labels…"
              className="w-full mb-2 px-2 py-1 text-xs bg-[#272727] text-white rounded-lg outline-none placeholder:text-[#666]"
            />
            {grouped.length === 0 && (
              <p className="px-1 py-2 text-[11px] text-[#666]">No matching labels.</p>
            )}
            {grouped.map(([group, items]) => (
              <div key={group} className="mb-1.5">
                <p className="px-1 mb-1 text-[10px] uppercase tracking-wider text-[#666]">{group}</p>
                <div className="flex flex-wrap gap-1">
                  {items.map((t) => (
                    <button
                      key={t.name}
                      onClick={() => send(t.name, 'POST')}
                      disabled={busy === t.name}
                      className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-[#272727] text-[#ccc] hover:bg-[#3a3a3a] transition-colors disabled:opacity-40"
                    >
                      <span>{t.icon}</span>
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
