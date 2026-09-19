import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import People from './People'
import PageDefaultsEditor from './PageDefaultsEditor'
import type { PageDefaultOverrides } from '../lib/pageDefaults'
import { setCaptionDefaults } from '../lib/captionDefaults'
import { setLangSetting, setTranslateSetting, t } from '../lib/i18n'

type SettingSpec = {
  key: string
  type: string
  label: string
  description: string
  group: string
  /** "user" (yours) or "app" (the machine's — see the badge below). */
  scope?: string
  /** Optional endpoint returning `{text}` — a live line under the description. */
  status?: string
  /** For type "choice": the allowed values, in menu order. */
  options?: { value: string; label: string }[]
}

/**
 * A setting's live status line, if it declares one. Kept generic: the page
 * knows a setting may have something current to say, not what any particular
 * setting says.
 */
function StatusLine({ path, refreshKey }: { path: string; refreshKey: unknown }) {
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    apiFetch(path, { quiet: true })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setText(d?.text ?? null) })
      .catch(() => { if (live) setText(null) })
    return () => { live = false }
  }, [path, refreshKey])

  if (!text) return null
  return <p className="mt-1.5 text-xs text-[#aaa]">{text}</p>
}

type SettingsResponse = {
  settings: SettingSpec[]
  values: Record<string, unknown>
}

/**
 * The extension's credential.
 *
 * The extension normally takes this for itself: its content script runs on THIS
 * page, where a request to the API is same-origin and carries the session, so
 * simply opening the app tells it whose account it belongs to. Shown here for
 * the cases that can't reach — an app served from something other than
 * localhost, or a second browser you want to point at this account by hand.
 *
 * Shown rather than hidden: anyone who can read this page is already signed in
 * as its owner, so there is nothing here they don't already have.
 */
function ExtensionKey() {
  const [key, setKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    apiFetch('/api/auth/api-key', { quiet: true })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setKey(d?.api_key ?? null) })
      .catch(() => { if (live) setKey(null) })
    return () => { live = false }
  }, [])

  if (!key) return null

  return (
    <section className="mb-8">
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-[#777]">
        {t('Extension')}
      </h3>
      <div className="min-w-0">
        <label className="text-sm font-medium text-white">{t('Your API key')}</label>
        <p className="mt-0.5 text-xs leading-relaxed text-[#777]">
          {t('The extension picks this up on its own the moment you open the app, so you usually never need it. Paste it into the extension’s options only when it can’t — on an app address other than localhost, say. It tells the extension whose history to record into and whose Watch Later to save to, so treat it like a password.')}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-[#3f3f3f] bg-[#1c1c1c] px-3 py-2 font-mono text-xs text-[#ddd]">
            {key}
          </code>
          <button
            onClick={() => {
              navigator.clipboard.writeText(key)
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            }}
            className="flex-shrink-0 cursor-pointer rounded-full bg-white px-4 py-2 text-xs font-medium text-black"
          >
            {copied ? t('Copied') : t('Copy')}
          </button>
        </div>
      </div>
    </section>
  )
}

/** A setting with a fixed set of answers. Labels arrive in English from the spec. */
function Choice({ value, options, busy, onChange }: {
  value: string; options: { value: string; label: string }[]; busy: boolean; onChange: (v: string) => void
}) {
  return (
    <select
      value={value}
      disabled={busy}
      onChange={(e) => onChange(e.target.value)}
      className="flex-shrink-0 cursor-pointer rounded-lg border border-[#3f3f3f] bg-[#1c1c1c] px-3 py-1.5 text-sm text-white disabled:opacity-50"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
    </select>
  )
}

function Toggle({ on, busy, onChange }: { on: boolean; busy: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-50 ${
        on ? 'bg-white' : 'bg-[#3f3f3f]'
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full transition-all ${
          on ? 'left-[22px] bg-black' : 'left-0.5 bg-[#888]'
        }`}
      />
    </button>
  )
}

/**
 * Settings, rendered from the spec the API serves rather than from a form
 * written here. Adding a setting is one entry in the backend's SPEC — this page
 * grows a control for it without being touched, which is the whole point of
 * having a page rather than another .env line.
 */
type PageProps = {
  // Page defaults take effect in the running app the moment they're saved,
  // not on the next reload — App owns the views they reset.
  onPageDefaultsChange?: (overrides: PageDefaultOverrides) => void
}

export default function SettingsPage({ onPageDefaultsChange }: PageProps = {}) {
  const [data, setData] = useState<SettingsResponse | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    apiFetch('/api/settings')
      .then((r) => r.json())
      .then((d: SettingsResponse) => { if (live) setData(d) })
      .catch(() => { if (live) setError(t('Could not load settings.')) })
    return () => { live = false }
  }, [])

  const update = useCallback(async (key: string, value: unknown): Promise<boolean> => {
    setBusy(key)
    setError(null)
    // Optimistic: a toggle that waits for a round-trip feels broken, and the
    // response replaces this wholesale anyway.
    setData((d) => (d ? { ...d, values: { ...d.values, [key]: value } } : d))
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { [key]: value } }),
      })
      if (!res.ok) throw new Error()
      const next: SettingsResponse = await res.json()
      // Settings the running app reads outside this page take effect now.
      // The language last: it remounts the app, this page included.
      setCaptionDefaults(next.values)
      setTranslateSetting(next.values.translate_lang)
      setData(next)
      if (key === 'app_language') setLangSetting(next.values.app_language)
      return true
    } catch {
      setError(t('Could not save that. Reloading the page will show what stuck.'))
      return false
    } finally {
      setBusy(null)
    }
  }, [])

  if (error && !data) {
    return <div className="px-6 py-8 text-sm text-[#aaa]">{error}</div>
  }
  if (!data) {
    return <div className="px-6 py-8 text-sm text-[#777]">{t('Loading…')}</div>
  }

  const groups = [...new Set(data.settings.map((s) => s.group))]

  return (
    <div className="px-6 py-4 max-w-2xl">
      <h2 className="text-xl font-bold text-white mb-6">{t('Settings')}</h2>

      {error && (
        <div className="mb-4 rounded-lg border border-[#5c2b2b] bg-[#2a1a1a] px-3 py-2 text-xs text-[#e0a0a0]">
          {error}
        </div>
      )}

      {groups.map((group) => (
        <section key={group} className="mb-8">
          <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-[#777]">
            {t(group)}
          </h3>
          <div className="flex flex-col gap-4">
            {data.settings.filter((s) => s.group === group).map((spec) => (
              <div key={spec.key} className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <label className="text-sm font-medium text-white">
                    {t(spec.label)}
                    {spec.scope === 'app' && (
                      // Some switches govern a shared resource — the archive
                      // fill spends one daily API quota for the whole machine —
                      // so changing them changes them for everybody. Worth
                      // saying before the click, not after.
                      <span className="ml-2 rounded-full border border-[#3f3f3f] px-1.5 py-0.5 align-middle text-[10px] font-normal uppercase tracking-wide text-[#888]">
                        {t('everyone')}
                      </span>
                    )}
                  </label>
                  <p className="mt-0.5 text-xs leading-relaxed text-[#777]">
                    {t(spec.description)}
                  </p>
                  {spec.status && (
                    <StatusLine path={spec.status} refreshKey={data.values[spec.key]} />
                  )}
                  {spec.type === 'page_defaults' && (
                    <PageDefaultsEditor
                      value={data.values[spec.key]}
                      onChange={(next) => {
                        void update(spec.key, next).then((ok) => { if (ok) onPageDefaultsChange?.(next) })
                      }}
                    />
                  )}
                </div>
                {spec.type === 'choice' && spec.options && (
                  <Choice
                    value={String(data.values[spec.key] ?? '')}
                    options={spec.options}
                    busy={busy === spec.key}
                    onChange={(v) => update(spec.key, v)}
                  />
                )}
                {spec.type === 'bool' && (
                  <Toggle
                    on={Boolean(data.values[spec.key])}
                    busy={busy === spec.key}
                    onChange={(v) => update(spec.key, v)}
                  />
                )}
              </div>
            ))}
          </div>
        </section>
      ))}

      <People />
      <ExtensionKey />
    </div>
  )
}
