import { Fragment, useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { setPageDefaultOverrides } from '../lib/pageDefaults'
import { setCaptionDefaults } from '../lib/captionDefaults'
import { setSpeedDefaults } from '../lib/playbackSpeeds'
import { getLang, onLangChange, setLangSetting, setTranslateSetting, t } from '../lib/i18n'

/**
 * Holds the app back until your settings are in.
 *
 * The app reads the URL into state on its very first render, and "what does
 * this page open on" is half of that reading — a param equal to the default is
 * left out of the URL, so the default decides what an ordinary link means.
 * Rendering first and correcting after would open the feed on the built-in
 * window and then jump to yours. The language is the same: painting in one and
 * switching to another is a flash of the wrong app. A settings read that fails
 * isn't fatal: the built-in defaults are a working app.
 *
 * A change of language remounts everything below (the `key`), which is how
 * every string — in components and plain helpers alike — picks it up. The URL
 * carries where you were, so you land back on the same page.
 */
export default function DefaultsLoader({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const [lang, setLang] = useState(getLang())

  useEffect(() => onLangChange(() => setLang(getLang())), [])

  useEffect(() => {
    let live = true
    apiFetch('/api/settings', { quiet: true })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return
        setPageDefaultOverrides(d.values?.page_defaults)
        setCaptionDefaults(d.values)
        setSpeedDefaults(d.values?.playback_speeds)
        setTranslateSetting(d.values?.translate_lang)
        setLangSetting(d.values?.app_language)
      })
      .catch(() => { /* built-in defaults */ })
      .finally(() => { if (live) setReady(true) })
    return () => { live = false }
  }, [])

  if (!ready) {
    return <div className="flex h-screen items-center justify-center text-sm text-[#777]">{t('Loading…')}</div>
  }
  return <Fragment key={lang}>{children}</Fragment>
}
