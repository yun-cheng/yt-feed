/**
 * What each page opens on: its time window, its sort and its watch-status
 * filter.
 *
 * Two layers. The built-in table below is the app's opinion, argued for entry
 * by entry. Over it sit YOUR overrides — the `page_defaults` setting, edited on
 * the settings page and loaded before the app first renders (see
 * DefaultsLoader), so a cold load, a pasted link and every "back to this page's
 * default" all agree on what the default is.
 *
 * Only what you changed is stored. A page you never touched keeps following the
 * built-in value, so improving a built-in reaches everyone who didn't pick
 * their own.
 */

import { formatAge, parseAge } from './timeWindow'

// Watched is off by default: the home feed is for finding something to watch,
// and things you've already seen are noise there.
export const DEFAULT_WATCH_STATUSES = ['unwatched', 'in_progress']

export type PageDefault = { age: string; sort: string; watch: string[] }
export type PageDefaultOverrides = Record<string, Partial<PageDefault>>

// Every filter and sort the UI exposes is mirrored in the query string, so a
// refresh — or a pasted link — lands on the same view.
//
// Pages keep SEPARATE sort / window / watch-status state (a channel page's sort
// isn't the feed's), but the URL carries one of each: the page being shown owns
// them, and every other page's copy sits at its own default. A value equal to
// that default is left out, so ordinary URLs stay short.
export const BUILT_IN_DEFAULTS: Record<string, PageDefault> = {
  feed: { age: '0-3', sort: 'likes', watch: DEFAULT_WATCH_STATUSES },
  // A channel page opens on a wider window (one channel posts far less often)
  // and with nothing filtered out — you came to see what it has.
  channel: { age: '0-30', sort: 'likes', watch: [] },
  channels: { age: '0-3', sort: 'subs', watch: [] },

  // ── The library pages ──
  // Watch Later, Imported, Downloads, History: lists you built on purpose,
  // rather than a stream of what's new. All four open on ALL TIME and in the
  // order the list keeps itself in ('recent'), because a list you assembled has
  // no "too old to bother with" — you put it there to come back to it, and a
  // three-day window would hide almost all of it on the first visit.
  //
  // Their window filters the moment a row JOINED the list — saved, imported,
  // downloaded, watched — not the video's publish date, which is what the sort
  // beside it orders by too. See `filterByTime`.
  watchlater: { age: '0-all', sort: 'recent', watch: DEFAULT_WATCH_STATUSES },
  // Imported shares the global watch-status selection (like Watch Later), so it
  // shares its default too; History and Downloads keep their own, unfiltered.
  imported: { age: '0-all', sort: 'recent', watch: DEFAULT_WATCH_STATUSES },
  downloads: { age: '0-all', sort: 'recent', watch: [] },
  history: { age: '0-all', sort: 'recent', watch: [] },
  // One playlist is the same kind of list, windowed by when each video joined
  // it. 'recent' leaves the order alone, which for an imported playlist means
  // YouTube's own order — the thing you'd least want a default to destroy.
  // Nothing filtered out, either: a playlist is a set you chose whole.
  playlist: { age: '0-all', sort: 'recent', watch: [] },
}

/** The pages that have defaults of their own. */
export const DEFAULT_PAGES = Object.keys(BUILT_IN_DEFAULTS)

// Watch Later and Imported don't HAVE a watch selection of their own — they
// read the feed's, one list of statuses for all three. So they have no default
// of their own either: theirs is whatever the feed's is.
export const SHARES_FEED_WATCH = new Set(['watchlater', 'imported'])

/**
 * One page's defaults under a given set of overrides. Pure, so the settings
 * page can show what an edit WOULD make a page open on before it's saved.
 * A page with no bar of its own (search, settings, …) answers with the feed's.
 */
export function resolveDefaults(page: string, overrides: PageDefaultOverrides): PageDefault {
  const key = page in BUILT_IN_DEFAULTS ? page : 'feed'
  const base = BUILT_IN_DEFAULTS[key]
  const mine = overrides[key] ?? {}
  const watch = SHARES_FEED_WATCH.has(key) ? overrides.feed?.watch : mine.watch
  return { age: mine.age ?? base.age, sort: mine.sort ?? base.sort, watch: watch ?? base.watch }
}

/**
 * Keep only overrides that could have come from the settings page: known pages,
 * an age the ladder can spell, strings where strings go. A stored value is
 * trusted no further than that — a broken one falls back to the built-in rather
 * than taking a page down.
 */
export function cleanOverrides(raw: unknown): PageDefaultOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PageDefaultOverrides = {}
  for (const [page, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(page in BUILT_IN_DEFAULTS) || !v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const clean: Partial<PageDefault> = {}
    if (typeof o.age === 'string') {
      const r = parseAge(o.age)
      if (r) clean.age = formatAge(r)
    }
    if (typeof o.sort === 'string' && o.sort) clean.sort = o.sort
    if (Array.isArray(o.watch) && o.watch.every(w => typeof w === 'string')) clean.watch = o.watch
    if (Object.keys(clean).length) out[page] = clean
  }
  return out
}

let current: PageDefaultOverrides = {}

/** Install the overrides every `defaultsFor` call reads from here on. */
export function setPageDefaultOverrides(raw: unknown) {
  current = cleanOverrides(raw)
}

/** One page's defaults, as they stand now. */
export const defaultsFor = (page: string): PageDefault => resolveDefaults(page, current)
