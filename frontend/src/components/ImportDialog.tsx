import { useEffect, useRef, useState } from 'react'

export type ImportResult = {
  added: { youtube_id: string; title: string }[]
  skipped: string[]
  failed: { input: string; error: string }[]
}

type Props = {
  onClose: () => void
  onImport: (urls: string) => Promise<ImportResult>
}

export default function ImportDialog({ onClose, onImport }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { areaRef.current?.focus() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      const res = await onImport(text)
      setResult(res)
      // Keep the links that didn't make it in the box so they can be fixed and
      // retried; clear everything on a clean run.
      setText(res.failed.map((f) => f.input).join('\n'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 p-4 pt-24"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-[#212121] p-5 shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-medium text-white">Import videos</h2>
        <p className="mt-1 text-xs text-[#888]">
          Paste YouTube links — one per line. Works with watch, youtu.be, shorts and live URLs.
        </p>

        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter alone inserts a newline (the box is a list); ⌘/Ctrl+Enter submits.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
          }}
          rows={5}
          placeholder="https://www.youtube.com/watch?v=…"
          className="mt-3 w-full resize-y rounded-lg bg-[#121212] px-3 py-2 text-sm text-white placeholder-[#555] outline-none ring-1 ring-[#303030] focus:ring-[#3ea6ff]"
        />

        {result && (
          <div className="mt-3 space-y-1 text-xs">
            {result.added.length > 0 && (
              <p className="text-green-400">Imported {result.added.length} video{result.added.length > 1 ? 's' : ''}.</p>
            )}
            {result.skipped.length > 0 && (
              <p className="text-[#888]">{result.skipped.length} already imported.</p>
            )}
            {result.failed.map((f) => (
              <p key={f.input} className="text-red-400 break-all">{f.input} — {f.error}</p>
            ))}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-full px-4 py-1.5 text-sm text-[#aaa] transition-colors hover:bg-white/10 hover:text-white"
          >
            {result && result.failed.length === 0 ? 'Done' : 'Cancel'}
          </button>
          <button
            onClick={submit}
            disabled={busy || !text.trim()}
            className="rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black transition-opacity hover:opacity-80 disabled:opacity-40"
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
