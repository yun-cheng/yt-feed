import { useEffect, useState } from 'react'
import {
  ACTIONS, conflictWith, keyFor, keyLabel, normalizeKey,
  type ActionId,
} from '../lib/shortcuts'
import { t } from '../lib/i18n'

/**
 * Every shortcut, and the key it's on.
 *
 * You rebind one by pressing the key you want rather than by typing its name:
 * the name of a key is the one thing nobody knows (`ArrowUp`? `Up`? `↑`?) and
 * the keyboard is right there. While a row is listening, the whole document's
 * keydown is ours — including keys the app normally acts on, since capturing
 * `f` must not also go fullscreen.
 *
 * Only what you changed is stored (see the `shortcuts` setting), so a row you
 * put back follows the built-in default again, including if it moves later.
 * Taking a key away is a third state, and stored as its own: an action with no
 * key is a shortcut you didn't want, which is not the same as one you never
 * touched.
 */
export default function ShortcutsEditor({ value, onChange }: {
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}) {
  // Which row is listening for a key, and what went wrong with the last one.
  const [listening, setListening] = useState<ActionId | null>(null)
  const [taken, setTaken] = useState<ActionId | null>(null)

  useEffect(() => {
    if (!listening) return
    const onKey = (e: KeyboardEvent) => {
      // Ours before anyone else's: this is the one moment a keypress means
      // "this key", not what the key does.
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setListening(null); setTaken(null); return }
      // A modifier on its own is the start of a chord, not a shortcut, and
      // space is spoken for everywhere (it plays and pauses).
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
      if (e.key === ' ' || e.metaKey || e.ctrlKey || e.altKey) return
      const key = normalizeKey(e.key)
      const clash = conflictWith(listening, key, value)
      if (clash) { setTaken(clash); return }
      const next = { ...value }
      // Back on its default is stored as nothing at all, not as a copy of it.
      if (key === ACTIONS.find((a) => a.id === listening)?.key) delete next[listening]
      else next[listening] = key
      setListening(null)
      setTaken(null)
      onChange(next)
    }
    // Capture, so the player's own window handlers never see these.
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [listening, value, onChange])

  const groups = [...new Set(ACTIONS.map((a) => a.group))]
  const label = (id: ActionId) => t(ACTIONS.find((a) => a.id === id)?.label ?? '')

  return (
    <div className="mt-2">
      {groups.map((group) => (
        <div key={group} className="mb-2">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-[#666]">{t(group)}</div>
          <div className="flex flex-col">
            {ACTIONS.filter((a) => a.group === group).map((a) => {
              const moved = a.id in value
              const waiting = listening === a.id
              return (
                <div key={a.id} className="flex items-center gap-2 py-0.5">
                  <span className="min-w-0 flex-1 truncate text-xs text-[#ccc]">{t(a.label)}</span>
                  {/* Take the key away. A shortcut you keep hitting by
                      accident is worth being rid of, and "off" is not the same
                      answer as "back on its default" — so this is its own
                      button, next to the one that undoes a move. Gone once the
                      row is already unbound. */}
                  {keyFor(a.id, value) !== '' && (
                    <button
                      onClick={() => { onChange({ ...value, [a.id]: '' }); setListening(null) }}
                      title={t('No key for this')}
                      aria-label={t('No key for {action}', { action: t(a.label) })}
                      className="cursor-pointer px-1 text-xs text-[#777] hover:text-white"
                    >
                      ✕
                    </button>
                  )}
                  {moved && (
                    <button
                      onClick={() => {
                        const next = { ...value }
                        delete next[a.id]
                        onChange(next)
                      }}
                      title={t('Back to {key}', { key: keyLabel(a.key) })}
                      aria-label={t('Back to {key}', { key: keyLabel(a.key) })}
                      className="cursor-pointer px-1 text-xs text-[#777] hover:text-white"
                    >
                      ↺
                    </button>
                  )}
                  <button
                    onClick={() => { setListening(waiting ? null : a.id); setTaken(null) }}
                    aria-label={t('Shortcut for {action}', { action: t(a.label) })}
                    className={`min-w-[4.5rem] cursor-pointer rounded-lg border px-2 py-1 font-mono text-xs ${
                      waiting
                        ? 'border-white bg-white/10 text-white'
                        : 'border-[#3f3f3f] bg-[#1c1c1c] text-[#ddd] hover:bg-white/5'
                    }`}
                  >
                    {waiting ? t('press a key') : keyLabel(keyFor(a.id, value))}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      <p className="mt-1 text-xs text-[#777]">
        {taken
          ? t('{action} is already on that key.', { action: label(taken) })
          : listening
            ? t('Press the key you want, or Esc to leave it alone.')
            : t('Space plays and pauses, and Esc closes — those two stay put.')}
      </p>
      {Object.keys(value).length > 0 && (
        <button
          onClick={() => onChange({})}
          className="mt-2 cursor-pointer rounded-full border border-[#3f3f3f] px-3 py-1.5 text-xs text-[#ccc] hover:bg-white/5"
        >
          {t('Reset')}
        </button>
      )}
    </div>
  )
}
