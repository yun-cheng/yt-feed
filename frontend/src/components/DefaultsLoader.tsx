import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { setPageDefaultOverrides } from '../lib/pageDefaults'

/**
 * Holds the app back until your page defaults are in.
 *
 * The app reads the URL into state on its very first render, and "what does
 * this page open on" is half of that reading — a param equal to the default is
 * left out of the URL, so the default decides what an ordinary link means.
 * Rendering first and correcting after would open the feed on the built-in
 * window and then jump to yours. A settings read that fails isn't fatal: the
 * built-in defaults are a working app.
 */
export default function DefaultsLoader({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let live = true
    apiFetch('/api/settings', { quiet: true })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setPageDefaultOverrides(d.values?.page_defaults) })
      .catch(() => { /* built-in defaults */ })
      .finally(() => { if (live) setReady(true) })
    return () => { live = false }
  }, [])

  if (!ready) {
    return <div className="flex h-screen items-center justify-center text-sm text-[#777]">Loading…</div>
  }
  return <>{children}</>
}
