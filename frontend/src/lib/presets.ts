/**
 * Saved filter presets — a sidebar selection, named and put back on later.
 *
 * A preset is a filter SET, not a place: it carries no page, and clicking one
 * applies it to whatever list you're on. The parts a page has no use for are
 * skipped rather than forced, which is what lets one preset ("unwatched, not
 * Shorts") work on the feed and on History alike.
 */
import { apiFetch } from './api'

/**
 * `watch: null` means "leave the watch statuses alone", which is not the same
 * as `[]` — an explicit "no watch filter". Saved from a page that has no watch
 * chips, a preset has nothing to say about them, and shouldn't clear them the
 * first time it lands somewhere that does.
 */
export type PresetFilters = {
  tags: string[]
  watch: string[] | null
  summarised: boolean
  shorts: boolean
  hidden: boolean
}

export type Preset = {
  id: number
  name: string
  filters: PresetFilters
  created_at: string | null
}

/** Which sidebar sections a page offers — App's `pageFilters`. */
export type FilterSections = {
  watchStatus: boolean
  tags: boolean
  hidden: boolean
  contentMode: boolean
  summarised: boolean
}

export const NO_FILTERS: PresetFilters = {
  tags: [], watch: null, summarised: false, shorts: false, hidden: false,
}

/** The sidebar's live state, in the terms a preset stores. */
export type LiveFilters = {
  tags: string[]
  watch: string[]
  summarised: boolean
  shorts: boolean
  hidden: boolean
}

/**
 * What "save the current filters" means on this page.
 *
 * Only the sections the page actually shows are captured. Saving on History
 * records nothing about "show hidden channels", a switch it never offered — so
 * the preset doesn't quietly carry a value the user never set.
 */
export function captureFilters(live: LiveFilters, on: FilterSections): PresetFilters {
  return {
    tags: on.tags ? [...live.tags] : [],
    watch: on.watchStatus ? [...live.watch] : null,
    summarised: on.summarised ? live.summarised : false,
    shorts: on.contentMode ? live.shorts : false,
    hidden: on.hidden ? live.hidden : false,
  }
}

/**
 * The preset as this page can actually wear it.
 *
 * History offers no "unwatched" chip — nothing on a list of what you've watched
 * can match it — so a preset carrying it is trimmed rather than applied whole.
 * Otherwise a filter would be in force with nothing on screen to show it or
 * turn it off. Used by both applying and the is-this-one-on comparison, so the
 * two can't disagree.
 */
export function forPage(p: PresetFilters, offered: readonly string[]): PresetFilters {
  if (!p.watch) return p
  return { ...p, watch: p.watch.filter(v => offered.includes(v)) }
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Is this preset the one currently on?
 *
 * Compared section by section, and only where the page offers the section — a
 * preset can't be "not matching" because of a chip that isn't on screen. A null
 * `watch` is likewise skipped, matching what applying it does: nothing.
 */
export function isActive(p: PresetFilters, live: LiveFilters, on: FilterSections): boolean {
  if (on.tags && !sameList([...p.tags].sort(), [...live.tags].sort())) return false
  if (on.watchStatus && p.watch && !sameList([...p.watch].sort(), [...live.watch].sort())) return false
  if (on.summarised && p.summarised !== live.summarised) return false
  if (on.contentMode && p.shorts !== live.shorts) return false
  if (on.hidden && p.hidden !== live.hidden) return false
  return true
}

/** Is there anything here worth saving? A preset of nothing is the Clear button. */
export function hasAnyFilter(f: PresetFilters): boolean {
  return f.tags.length > 0 || (f.watch?.length ?? 0) > 0 || f.summarised || f.shorts || f.hidden
}

export async function listPresets(): Promise<Preset[]> {
  const res = await apiFetch('/api/presets')
  if (!res.ok) return []
  return res.json()
}

export async function savePreset(name: string, filters: PresetFilters): Promise<Preset | null> {
  const res = await apiFetch('/api/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, filters }),
  })
  return res.ok ? res.json() : null
}

export async function deletePreset(id: number): Promise<boolean> {
  const res = await apiFetch(`/api/presets/${id}`, { method: 'DELETE' })
  return res.ok
}
