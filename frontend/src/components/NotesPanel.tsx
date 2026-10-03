/**
 * The panel's Notes tab: what you write about a video — labels, fields that
 * each hold several values (Actors: Ann, Bo), and a note.
 *
 * Saved as you go, whole (routers/notes.py): every change schedules one PUT of
 * everything the tab holds, a moment after the last keystroke, and leaving the
 * video or the page sends whatever is still waiting. Nothing is saved before
 * the video's notes have arrived, so an empty tab can't overwrite them.
 *
 * Typing here never reaches the player: its shortcuts ignore keys from inputs
 * and textareas. Escape hands the keyboard back, as it does in Ask.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { apiFetch } from '../lib/api'
import { t } from '../lib/i18n'
import { PanelScroll } from './VideoPanel'
import { rememberNotes } from '../hooks/notesStore'

export type NoteField = { name: string; values: string[] }
export type VideoNotes = { labels: string[]; fields: NoteField[]; note: string }
type Suggestions = { labels: string[]; fields: Record<string, string[]> }

const EMPTY: VideoNotes = { labels: [], fields: [], note: '' }
// Long enough that a word typed is one save, short enough that closing the tab
// straight after rarely has anything left to send.
const SAVE_DELAY_MS = 700

const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()
const has = (list: string[], item: string) => list.some((x) => same(x, item))

/** The suggestions for one field, found by its name in any case. */
function valuesFor(s: Suggestions, name: string): string[] {
  const key = Object.keys(s.fields).find((k) => same(k, name))
  return key ? s.fields[key] : []
}

const X_ICON = (
  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
    <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
  </svg>
)

function Chip({ children, onRemove }: { children: string; onRemove: () => void }) {
  return (
    <span className="flex max-w-full items-center gap-1 rounded-full bg-white/15 py-0.5 pl-2.5 pr-1 text-xs text-white">
      <span className="truncate">{children}</span>
      <button
        onClick={onRemove}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-shade-cc transition-colors hover:bg-white/20 hover:text-white"
        title={t('Remove {name}', { name: children })}
        aria-label={t('Remove {name}', { name: children })}
      >
        {X_ICON}
      </button>
    </span>
  )
}

/**
 * A line of an entry box: Enter (or a comma) adds what's typed, Backspace on
 * an empty box takes back the last one. Offers `suggestions` through the
 * browser's own list, minus what's already there.
 */
function AddBox({ placeholder, suggestions, onAdd, onBackspace, label, inputRef }: {
  placeholder: string
  suggestions: string[]
  onAdd: (value: string) => void
  onBackspace?: () => void
  label: string
  inputRef?: (el: HTMLInputElement | null) => void
}) {
  const [draft, setDraft] = useState('')
  const listId = useId()
  const add = () => {
    if (draft.trim()) onAdd(draft.trim())
    setDraft('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      // Not while an IME is composing: Enter there picks the characters.
      if (e.nativeEvent.isComposing) return
      e.preventDefault()
      add()
    } else if (e.key === 'Backspace' && !draft && onBackspace) {
      onBackspace()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      e.currentTarget.blur()
    }
  }
  return (
    <>
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => {
          // A pick from the list arrives as a change, not a key: add it whole.
          const v = e.target.value
          if ((e.nativeEvent as InputEvent).inputType === 'insertReplacementText' && suggestions.includes(v)) {
            onAdd(v); setDraft(''); return
          }
          setDraft(v)
        }}
        onKeyDown={onKeyDown}
        onBlur={add}
        list={suggestions.length ? listId : undefined}
        placeholder={placeholder}
        aria-label={label}
        className="min-w-[6rem] flex-1 bg-transparent py-0.5 text-xs text-white placeholder:text-shade-88 focus:outline-none"
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => <option key={s} value={s} />)}
        </datalist>
      )}
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-shade-99">{title}</h3>
      {children}
    </section>
  )
}

const BOX = 'flex flex-wrap items-center gap-1.5 rounded-xl bg-shade-12 px-2 py-1.5 ring-1 ring-white/10 focus-within:ring-white/25'

export default function NotesPanel({ videoId }: { videoId: string }) {
  const [notes, setNotes] = useState<VideoNotes | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestions>({ labels: [], fields: {} })
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  // What's waiting to be sent, and its timer — refs so leaving can send it.
  const pending = useRef<VideoNotes | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const valueBoxes = useRef(new Map<string, HTMLInputElement>())
  const [focusField, setFocusField] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    apiFetch(`/api/notes/video/${encodeURIComponent(videoId)}`)
      .then((r) => (r.ok ? r.json() : EMPTY))
      .then((n: VideoNotes) => { if (alive) setNotes({ labels: n.labels, fields: n.fields, note: n.note }) })
      .catch(() => { if (alive) setNotes(EMPTY) })
    apiFetch('/api/notes/suggestions', { quiet: true })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Suggestions | null) => { if (alive && s) setSuggestions(s) })
      .catch(() => {})
    return () => { alive = false }
  }, [videoId])

  const send = useCallback((body: VideoNotes, keepalive = false) => {
    pending.current = null
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    setStatus('saving')
    return apiFetch(`/api/notes/video/${encodeURIComponent(videoId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive,
    })
      .then(async (r) => {
        if (!r.ok) return
        // The cards' copy, as the server kept it — sent on leaving too, so
        // the card you go back to already shows it.
        rememberNotes(videoId, await r.json())
        if (!pending.current) setStatus('saved')
      })
      .catch(() => {})
  }, [videoId])

  // Leaving — another video, or the page — sends what hasn't gone yet.
  useEffect(() => {
    const flush = () => { if (pending.current) void send(pending.current, true) }
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush); flush() }
  }, [send])

  const change = (next: VideoNotes) => {
    setNotes(next)
    pending.current = next
    setStatus('idle')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { if (pending.current) void send(pending.current) }, SAVE_DELAY_MS)
  }

  // A field just made gets the cursor in its value box.
  useEffect(() => {
    if (focusField === null) return
    valueBoxes.current.get(focusField.toLocaleLowerCase())?.focus()
    setFocusField(null)
  }, [focusField, notes])

  if (!notes) {
    return <PanelScroll><p className="text-xs text-shade-99">{t('Loading…')}</p></PanelScroll>
  }

  const addLabel = (label: string) => {
    if (!has(notes.labels, label)) change({ ...notes, labels: [...notes.labels, label] })
  }
  const setField = (i: number, values: string[]) => change({
    ...notes, fields: notes.fields.map((f, j) => (j === i ? { ...f, values } : f)),
  })
  const addField = (name: string) => {
    if (!has(notes.fields.map((f) => f.name), name)) {
      change({ ...notes, fields: [...notes.fields, { name, values: [] }] })
    }
    setFocusField(name)
  }

  return (
    <PanelScroll>
      <Section title={t('Labels')}>
        <div className={BOX}>
          {notes.labels.map((l) => (
            <Chip key={l} onRemove={() => change({ ...notes, labels: notes.labels.filter((x) => x !== l) })}>{l}</Chip>
          ))}
          <AddBox
            label={t('Add a label')}
            placeholder={t('Add a label')}
            suggestions={suggestions.labels.filter((s) => !has(notes.labels, s))}
            onAdd={addLabel}
            onBackspace={() => notes.labels.length && change({ ...notes, labels: notes.labels.slice(0, -1) })}
          />
        </div>
      </Section>

      <Section title={t('Fields')}>
        <div className="flex flex-col gap-2">
          {notes.fields.map((f, i) => (
            <div key={f.name} data-testid="note-field">
              <div className="mb-1 flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-shade-dd">{f.name}</span>
                <button
                  onClick={() => change({ ...notes, fields: notes.fields.filter((_, j) => j !== i) })}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-shade-aa transition-colors hover:bg-white/10 hover:text-white"
                  title={t('Remove the field {name}', { name: f.name })}
                  aria-label={t('Remove the field {name}', { name: f.name })}
                >
                  {X_ICON}
                </button>
              </div>
              <div className={BOX}>
                {f.values.map((v) => (
                  <Chip key={v} onRemove={() => setField(i, f.values.filter((x) => x !== v))}>{v}</Chip>
                ))}
                <AddBox
                  inputRef={(el) => {
                    const key = f.name.toLocaleLowerCase()
                    if (el) valueBoxes.current.set(key, el); else valueBoxes.current.delete(key)
                  }}
                  label={t('Add to {name}', { name: f.name })}
                  placeholder={t('Add to {name}', { name: f.name })}
                  suggestions={valuesFor(suggestions, f.name).filter((s) => !has(f.values, s))}
                  onAdd={(v) => { if (!has(f.values, v)) setField(i, [...f.values, v]) }}
                  onBackspace={() => f.values.length && setField(i, f.values.slice(0, -1))}
                />
              </div>
            </div>
          ))}
          <div className={BOX}>
            <svg className="h-3.5 w-3.5 shrink-0 text-shade-99" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
              <path strokeLinecap="round" d="M12 5v14M5 12h14" />
            </svg>
            <AddBox
              label={t('Add a field')}
              placeholder={t('Add a field, like Actors')}
              suggestions={Object.keys(suggestions.fields).filter((s) => !has(notes.fields.map((f) => f.name), s))}
              onAdd={addField}
            />
          </div>
        </div>
      </Section>

      <Section title={t('Note')}>
        <textarea
          value={notes.note}
          onChange={(e) => change({ ...notes, note: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.blur() } }}
          rows={6}
          placeholder={t('Write anything about this video…')}
          aria-label={t('Note')}
          className="w-full resize-y rounded-xl bg-shade-12 px-2.5 py-2 text-(length:--panel-body) leading-snug text-white ring-1 ring-white/10 placeholder:text-shade-88 focus:outline-none focus:ring-white/25"
        />
      </Section>

      <p className="h-4 text-right text-xs text-shade-99" aria-live="polite">
        {status === 'saving' ? t('Saving…') : status === 'saved' ? t('Saved') : ''}
      </p>
    </PanelScroll>
  )
}
