import { useEffect, useRef, useState } from 'react'
import TimeSortControls from './TimeSortControls'
import { HISTORY_WATCH_OPTIONS, WATCH_STATUSES, pageFilters, pageHasWindow } from '../App'
import {
  BUILT_IN_DEFAULTS, SHARES_FEED_WATCH, cleanOverrides, resolveDefaults,
  type PageDefault, type PageDefaultOverrides,
} from '../lib/pageDefaults'
import { formatAge, parseAge, DEFAULT_RANGE } from '../lib/timeWindow'
import { t } from '../lib/i18n'

// In the order the sidebar lists them, named the way it names them.
const PAGES: { page: string; label: string }[] = [
  { page: 'feed', label: 'Home' },
  { page: 'channel', label: 'A channel' },
  { page: 'channels', label: 'Channels' },
  { page: 'watchlater', label: 'Watch Later' },
  { page: 'imported', label: 'Imported' },
  { page: 'downloads', label: 'Downloads' },
  { page: 'history', label: 'History' },
  { page: 'playlist', label: 'A playlist' },
]

// Dragging the slider fires on every notch; one save per pause is plenty.
const SAVE_AFTER_MS = 500

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(v => b.includes(v))

/**
 * One field of one page set to a value. Setting a field back to the built-in
 * value REMOVES the override rather than storing a copy of it, so a page you
 * put back follows the built-in again — including when the built-in changes.
 */
export function withDefault<K extends keyof PageDefault>(
  overrides: PageDefaultOverrides, page: string, field: K, value: PageDefault[K],
): PageDefaultOverrides {
  const built = BUILT_IN_DEFAULTS[page][field]
  const same = Array.isArray(value) ? sameSet(value, built as string[]) : value === built
  const mine: Partial<PageDefault> = { ...overrides[page] }
  if (same) delete mine[field]
  else mine[field] = value
  const next = { ...overrides }
  if (Object.keys(mine).length) next[page] = mine
  else delete next[page]
  return next
}

type Props = {
  value: unknown
  onChange: (next: PageDefaultOverrides) => void
}

/**
 * Every page's opening window, sort and watch filter, edited with the same
 * controls the page itself shows — the slider and sort row are the page's own
 * TimeSortControls, so what you set here looks exactly like what you'll land on.
 */
export default function PageDefaultsEditor({ value, onChange }: Props) {
  const [draft, setDraft] = useState<PageDefaultOverrides>(() => cleanOverrides(value))
  const pending = useRef<PageDefaultOverrides | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const flush = () => {
    clearTimeout(timer.current)
    if (pending.current) onChangeRef.current(pending.current)
    pending.current = null
  }
  // Leaving the page mid-pause still saves the last thing you set.
  useEffect(() => flush, [])

  const set = (next: PageDefaultOverrides) => {
    setDraft(next)
    pending.current = next
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_AFTER_MS)
  }

  return (
    <div className="mt-4 flex flex-col divide-y divide-[#272727] rounded-xl border border-[#272727]">
      {PAGES.map(({ page, label }) => {
        const d = resolveDefaults(page, draft)
        const hasWatch = pageFilters(page).watchStatus
        const ownWatch = hasWatch && !SHARES_FEED_WATCH.has(page)
        const options = page === 'history' ? HISTORY_WATCH_OPTIONS : WATCH_STATUSES
        const changed = !!draft[page]
        const put = <K extends keyof PageDefault>(field: K, v: PageDefault[K]) =>
          set(withDefault(draft, page, field, v))

        return (
          <div key={page} className="flex flex-col gap-3 px-4 py-3" data-testid={`defaults-${page}`}>
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-white">{t(label)}</span>
              {changed && (
                <button
                  onClick={() => {
                    const next = { ...draft }
                    delete next[page]
                    set(next)
                  }}
                  className="ml-auto text-xs text-[#777] hover:text-white"
                >
                  {t('Reset')}
                </button>
              )}
            </div>

            <TimeSortControls
              variant={page}
              age={pageHasWindow(page) ? parseAge(d.age) ?? DEFAULT_RANGE : undefined}
              onAgeChange={pageHasWindow(page) ? (r) => put('age', formatAge(r)) : undefined}
              sort={d.sort}
              onSortChange={(s) => put('sort', s)}
              stacked
            />

            {ownWatch && (
              <div className="flex flex-wrap items-center gap-1.5">
                {options.map((w) => {
                  const on = d.watch.includes(w.value)
                  return (
                    <button
                      key={w.value}
                      aria-pressed={on}
                      onClick={() => put('watch', on ? d.watch.filter(v => v !== w.value) : [...d.watch, w.value])}
                      className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                        on ? 'bg-white text-black' : 'bg-[#1a1a1a] text-[#aaa] hover:text-white'
                      }`}
                    >
                      {w.icon} {t(w.label)}
                    </button>
                  )
                })}
                <span className="ml-1 text-xs text-[#666]">
                  {d.watch.length === 0 || d.watch.length >= options.length ? t('Shows everything') : ''}
                </span>
              </div>
            )}
            {hasWatch && !ownWatch && (
              <p className="text-xs text-[#666]">{t('Watch filter follows Home’s.')}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}
