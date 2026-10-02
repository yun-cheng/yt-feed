/**
 * The `theme` setting, applied as <html data-theme>, which is what index.css
 * hangs every color off.
 *
 * A copy is kept in the browser so that index.html's inline script can apply it
 * before the first paint: the setting itself arrives with /api/settings, after
 * the page has already been drawn once, and a light page that flashes dark on
 * every load is worse than no light theme.
 */

export type ThemeSetting = 'dark' | 'light' | 'system'
export type Theme = 'dark' | 'light'

// Read by name in index.html's inline script too.
const STORAGE_KEY = 'ytfeed:theme'

const isSetting = (v: unknown): v is ThemeSetting => v === 'dark' || v === 'light' || v === 'system'

const lightQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null

/** 'system' → whichever the device prefers; anything unknown → dark. */
export function resolveTheme(setting: unknown, prefersLight = lightQuery?.matches ?? false): Theme {
  if (setting === 'light' || setting === 'dark') return setting
  if (setting === 'system') return prefersLight ? 'light' : 'dark'
  return 'dark'
}

function stored(): ThemeSetting | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isSetting(v) ? v : null
  } catch { return null }
}

let setting: ThemeSetting = stored() ?? 'dark'
apply()

// Following the system means following it while the page is open, too.
lightQuery?.addEventListener?.('change', () => { if (setting === 'system') apply() })

function apply() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const next = resolveTheme(setting)
  if (root.dataset.theme === next) return
  // Every `transition-colors` element would otherwise fade across on its own
  // clock, and the page would change theme in patches. Held off for the one
  // style recalculation the switch takes, it changes all at once.
  const hold = document.createElement('style')
  hold.textContent = '*,*::before,*::after{transition:none!important}'
  document.head.appendChild(hold)
  root.dataset.theme = next
  void document.body?.offsetHeight
  hold.remove()
}

export function getThemeSetting(): ThemeSetting { return setting }

/** Install the `theme` setting as served. */
export function setThemeSetting(value: unknown) {
  setting = isSetting(value) ? value : 'dark'
  try { localStorage.setItem(STORAGE_KEY, setting) } catch { /* ignore */ }
  apply()
}
