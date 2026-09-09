import { describe, it, expect } from 'vitest'
import { captureFilters, forPage, hasAnyFilter, isActive, NO_FILTERS } from '../lib/presets'
import type { FilterSections, LiveFilters } from '../lib/presets'

const ALL: FilterSections = {
  watchStatus: true, tags: true, hidden: true, contentMode: true, summarised: true, length: true,
}
// What History offers: statuses, tags, summaries and the Shorts toggle — but no
// "show hidden channels", which only changes the home feed's query.
const HISTORY: FilterSections = { ...ALL, hidden: false }
const NOTHING: FilterSections = {
  watchStatus: false, tags: false, hidden: false, contentMode: false, summarised: false, length: false,
}

const live = (over: Partial<LiveFilters> = {}): LiveFilters => ({
  tags: [], watch: [], summarised: false, shorts: false, hidden: false, length: [], ...over,
})

describe('captureFilters', () => {
  it('records the whole selection where the page offers all of it', () => {
    expect(captureFilters(
      live({ tags: ['chinese', '-piano'], watch: ['unwatched'], summarised: true, shorts: true, hidden: true }),
      ALL,
    )).toEqual({
      tags: ['chinese', '-piano'], watch: ['unwatched'],
      summarised: true, shorts: true, hidden: true, length: [],
    })
  })

  it('drops what the page never offered rather than freezing a value you never set', () => {
    // `showHidden` is live app state even on History, which has no switch for
    // it. Saving there shouldn't smuggle it into the preset.
    const p = captureFilters(live({ tags: ['music'], hidden: true }), HISTORY)
    expect(p.hidden).toBe(false)
    expect(p.tags).toEqual(['music'])
  })

  it('leaves watch null on a page without the chips, which is not the same as empty', () => {
    expect(captureFilters(live({ watch: ['watched'] }), { ...ALL, watchStatus: false }).watch).toBeNull()
  })

  it('copies the tag list rather than aliasing it', () => {
    const source = live({ tags: ['a'] })
    const p = captureFilters(source, ALL)
    source.tags.push('b')
    expect(p.tags).toEqual(['a'])
  })
})

describe('isActive', () => {
  const preset = { ...NO_FILTERS, tags: ['chinese'], watch: ['unwatched'] }

  it('is on when the selection matches', () => {
    expect(isActive(preset, live({ tags: ['chinese'], watch: ['unwatched'] }), ALL)).toBe(true)
  })

  it('ignores the order the chips were clicked in', () => {
    const p = { ...NO_FILTERS, tags: ['a', 'b'] }
    expect(isActive(p, live({ tags: ['b', 'a'] }), ALL)).toBe(true)
  })

  it('is off when a filter differs', () => {
    expect(isActive(preset, live({ tags: ['chinese'], watch: [] }), ALL)).toBe(false)
    expect(isActive(preset, live({ tags: ['piano'], watch: ['unwatched'] }), ALL)).toBe(false)
  })

  it("doesn't fail on a section the page isn't showing", () => {
    // The tags disagree, but this page has no tag chips — the preset is still
    // the one in force, because applying it again would change nothing.
    expect(isActive(preset, live({ tags: [], watch: ['unwatched'] }), { ...ALL, tags: false })).toBe(true)
  })

  it('skips a null watch, matching what applying it does', () => {
    const p = { ...NO_FILTERS, tags: ['chinese'] }
    expect(isActive(p, live({ tags: ['chinese'], watch: ['watched'] }), ALL)).toBe(true)
  })

  it('is trivially on for a preset of nothing on a page that filters nothing', () => {
    expect(isActive(NO_FILTERS, live(), NOTHING)).toBe(true)
  })
})

describe('hasAnyFilter', () => {
  it('is false for an empty selection — that preset would be the Clear button', () => {
    expect(hasAnyFilter(NO_FILTERS)).toBe(false)
  })

  it('counts an explicitly empty watch list, which is "every status"', () => {
    // Turning every watch chip OFF is a selection: the pages default to
    // unwatched-and-in-progress, so "show me the lot" is a state you have to
    // ask for — and one you could save under a name like any other. A null
    // list stays nothing, being the preset having no opinion at all.
    expect(hasAnyFilter({ ...NO_FILTERS, watch: [] })).toBe(true)
    expect(hasAnyFilter({ ...NO_FILTERS, watch: null })).toBe(false)
  })

  it('is true for any one of them', () => {
    expect(hasAnyFilter({ ...NO_FILTERS, tags: ['a'] })).toBe(true)
    expect(hasAnyFilter({ ...NO_FILTERS, watch: ['watched'] })).toBe(true)
    expect(hasAnyFilter({ ...NO_FILTERS, summarised: true })).toBe(true)
    expect(hasAnyFilter({ ...NO_FILTERS, shorts: true })).toBe(true)
    expect(hasAnyFilter({ ...NO_FILTERS, hidden: true })).toBe(true)
    expect(hasAnyFilter({ ...NO_FILTERS, length: ['under5'] })).toBe(true)
  })

  it('does not count an empty length list, whose empty IS the default', () => {
    // The mirror image of the watch statuses above. No length chip on means
    // "any length", which is what you get without asking — so a preset holding
    // only that would restore nothing.
    expect(hasAnyFilter({ ...NO_FILTERS, length: [] })).toBe(false)
    expect(hasAnyFilter({ ...NO_FILTERS, length: null })).toBe(false)
  })
})

describe('length in a preset', () => {
  it('is captured only where the page has the chips', () => {
    expect(captureFilters(live({ length: ['under5'] }), ALL).length).toEqual(['under5'])
    // Saved from a page with no length section, the preset has no opinion
    // about it — null, not an empty list that would clear someone else's.
    expect(captureFilters(live({ length: ['under5'] }), NOTHING).length).toBeNull()
  })

  it('decides whether the preset is the one currently on', () => {
    const p = { ...NO_FILTERS, length: ['under5', 'over20'] }
    // Order is a chip-clicking accident, not part of the selection.
    expect(isActive(p, live({ length: ['over20', 'under5'] }), ALL)).toBe(true)
    expect(isActive(p, live({ length: ['under5'] }), ALL)).toBe(false)
    // A page with no length chips can't be the reason a preset doesn't match.
    expect(isActive(p, live({ length: [] }), { ...ALL, length: false })).toBe(true)
  })

  it('lets a null length pass on a page that does have the chips', () => {
    // Nothing to say about the lengths is not "clear the lengths" — the same
    // rule a null watch list follows.
    expect(isActive(NO_FILTERS, live({ length: ['under5'] }), ALL)).toBe(true)
  })
})

describe('forPage', () => {
  const OFFERED = ['in_progress', 'watched']  // History's chips

  it('trims a status the page has no chip for', () => {
    const p = { ...NO_FILTERS, tags: ['music'], watch: ['unwatched', 'watched'] }
    expect(forPage(p, OFFERED).watch).toEqual(['watched'])
    // Everything else rides along untouched.
    expect(forPage(p, OFFERED).tags).toEqual(['music'])
  })

  it('leaves a null watch alone rather than turning it into an empty list', () => {
    expect(forPage({ ...NO_FILTERS, tags: ['a'] }, OFFERED).watch).toBeNull()
  })

  it('leaves a preset the page can wear whole exactly as it was', () => {
    const p = { ...NO_FILTERS, watch: ['watched'] }
    expect(forPage(p, OFFERED)).toEqual(p)
  })
})
