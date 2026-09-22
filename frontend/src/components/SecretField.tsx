/**
 * An API key, as a control you can save into but never read out of.
 *
 * The asymmetry is the whole design. `GET /api/settings` returns
 * `{set, hint, from_env}` for a secret and never the value, so this field has
 * nothing to prefill with — it starts empty on every load, even when a key is
 * very much set. That reads as "not configured" unless the field says otherwise,
 * so it says so: the status line above the input reports that a key is in place
 * and which one, and the input's job is only to replace it.
 *
 * Three things a key needs that a toggle doesn't:
 *
 *   - **Save, explicitly.** Every other control on the settings page saves as you
 *     touch it, which is right for a switch and wrong for a 40-character paste:
 *     saving on each keystroke would store a dozen truncated keys on the way to
 *     the real one, and each of those is a round trip that fails.
 *   - **Clear, as its own action.** Submitting an empty field is ambiguous — it is
 *     what an untouched field looks like. So clearing is a button that says so.
 *   - **Test.** A wrong key doesn't announce itself; it shows up later as a
 *     channel that never gets tagged. One round trip at the moment of typing
 *     turns that into an answer.
 */
import { useState } from 'react'
import { apiFetch } from '../lib/api'
import { t } from '../lib/i18n'

/** What the API says about a secret, which is never its value. */
export type SecretView = {
  set?: boolean
  /** The last few characters, for telling one key from another. */
  hint?: string
  /** Set from the environment rather than here — so this field can say that
   *  clearing it will reveal that value rather than turn the feature off. */
  from_env?: boolean
}

export default function SecretField({ settingKey, view, multiline, placeholder, testable, busy, onSave }: {
  settingKey: string
  view: SecretView
  multiline?: boolean
  placeholder?: string
  testable?: boolean
  busy: boolean
  onSave: (value: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState('')
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const isSet = Boolean(view?.set)
  const dirty = draft.trim().length > 0

  async function save(value: string) {
    // A fresh test result belongs to the key that was there when it ran.
    setTested(null)
    const ok = await onSave(value)
    if (ok) setDraft('')
  }

  async function test() {
    setTesting(true)
    setTested(null)
    try {
      const res = await apiFetch(`/api/settings/test/${settingKey}`, {
        method: 'POST',
        // A key that doesn't work is this button's ordinary answer, reported in
        // place — a toast on top of it would be the app shouting about something
        // you just asked it to check.
        quiet: true,
      })
      const body = res.ok ? await res.json() : null
      setTested(body ?? { ok: false, text: t('Could not run the check.') })
    } catch {
      setTested({ ok: false, text: t('Could not run the check.') })
    } finally {
      setTesting(false)
    }
  }

  const Input = multiline ? 'textarea' : 'input'

  return (
    <div className="mt-2">
      <div className="mb-1.5 flex items-center gap-2 text-xs">
        {isSet ? (
          <>
            <span className="text-[#7ac77a]">
              {t('Set')}
              {view.hint ? <span className="ml-1 font-mono text-[#888]">{view.hint}</span> : null}
            </span>
            {view.from_env && (
              // Otherwise clearing it looks like it did nothing: the value comes
              // back from the environment, which is correct and invisible.
              <span className="rounded-full border border-[#3f3f3f] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#888]">
                {t('from .env')}
              </span>
            )}
          </>
        ) : (
          <span className="text-[#777]">{t('Not set')}</span>
        )}
      </div>

      <Input
        // `password` so it isn't left on screen, and so a browser doesn't offer
        // to remember somebody's API key as a login. The multiline one can't be:
        // a textarea has no masked mode, and a cookie jar is too long to check by
        // eye anyway — which is what the paste needs.
        {...(multiline ? { rows: 4 } : { type: 'password' })}
        value={draft}
        disabled={busy}
        spellCheck={false}
        autoComplete="off"
        placeholder={isSet ? t('Enter a new value to replace it') : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        className="w-full rounded-lg border border-[#3f3f3f] bg-[#1c1c1c] px-3 py-2 font-mono text-xs text-white placeholder:text-[#555] disabled:opacity-50"
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          disabled={busy || !dirty}
          onClick={() => void save(draft)}
          className="cursor-pointer rounded-full bg-white px-3 py-1.5 text-xs font-medium text-black disabled:cursor-default disabled:opacity-40"
        >
          {t('Save')}
        </button>
        {isSet && !view.from_env && (
          <button
            disabled={busy}
            onClick={() => void save('')}
            className="cursor-pointer rounded-full border border-[#3f3f3f] px-3 py-1.5 text-xs text-[#ccc] disabled:opacity-40"
          >
            {t('Clear')}
          </button>
        )}
        {testable && (
          <button
            disabled={busy || testing}
            onClick={() => void test()}
            className="cursor-pointer rounded-full border border-[#3f3f3f] px-3 py-1.5 text-xs text-[#ccc] disabled:opacity-40"
          >
            {testing ? t('Checking…') : t('Test')}
          </button>
        )}
        {tested && (
          <span className={`text-xs ${tested.ok ? 'text-[#7ac77a]' : 'text-[#e0a0a0]'}`}>
            {tested.text}
          </span>
        )}
      </div>
    </div>
  )
}
