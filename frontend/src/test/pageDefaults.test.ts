import { describe, it, expect, afterEach } from 'vitest'
import {
  BUILT_IN_DEFAULTS, DEFAULT_WATCH_STATUSES, cleanOverrides, defaultsFor, resolveDefaults,
  setPageDefaultOverrides,
} from '../lib/pageDefaults'
import { withDefault } from '../components/PageDefaultsEditor'
import { buildPath, loadWatchStatuses } from '../App'

afterEach(() => {
  setPageDefaultOverrides({})
  localStorage.clear()
})

describe('resolveDefaults', () => {
  it('is the built-in table when nothing is overridden', () => {
    expect(resolveDefaults('history', {})).toEqual(BUILT_IN_DEFAULTS.history)
  })

  it('takes each overridden field and keeps the rest built in', () => {
    expect(resolveDefaults('feed', { feed: { sort: 'newest' } }))
      .toEqual({ age: '0-3', sort: 'newest', watch: DEFAULT_WATCH_STATUSES })
  })

  it("gives Watch Later and Imported the feed's watch default, since they share its selection", () => {
    const o = { feed: { watch: ['watched'] }, watchlater: { watch: ['unwatched'] } }
    expect(resolveDefaults('watchlater', o).watch).toEqual(['watched'])
    expect(resolveDefaults('imported', o).watch).toEqual(['watched'])
  })

  it("answers a page with no defaults of its own with the feed's", () => {
    expect(resolveDefaults('search', { feed: { age: '0-7' } }).age).toBe('0-7')
  })
})

describe('cleanOverrides', () => {
  it('keeps what the settings page could have written', () => {
    const o = { feed: { age: '0-7', sort: 'score', watch: [] } }
    expect(cleanOverrides(o)).toEqual(o)
  })

  it('drops unknown pages, unreadable ages and ill-typed fields', () => {
    expect(cleanOverrides({
      nowhere: { sort: 'views' },
      feed: { age: 'yesterday', sort: 3, watch: 'watched' },
      history: { sort: 'views' },
    })).toEqual({ history: { sort: 'views' } })
  })

  it('reads anything that is not an object as no overrides', () => {
    expect(cleanOverrides(null)).toEqual({})
    expect(cleanOverrides([])).toEqual({})
    expect(cleanOverrides('feed')).toEqual({})
  })
})

describe('withDefault', () => {
  it('stores a field that differs from the built-in', () => {
    expect(withDefault({}, 'feed', 'sort', 'views')).toEqual({ feed: { sort: 'views' } })
  })

  it('forgets a field set back to the built-in, and the page once nothing is left', () => {
    expect(withDefault({ feed: { sort: 'views' } }, 'feed', 'sort', 'likes')).toEqual({})
    expect(withDefault({ feed: { sort: 'views', age: '0-7' } }, 'feed', 'sort', 'likes'))
      .toEqual({ feed: { age: '0-7' } })
  })

  it('compares watch statuses as a set', () => {
    expect(withDefault({}, 'feed', 'watch', ['in_progress', 'unwatched'])).toEqual({})
  })
})

describe('the app reads the installed overrides', () => {
  it('leaves a value out of the URL when it equals YOUR default', () => {
    setPageDefaultOverrides({ feed: { sort: 'newest' } })
    expect(defaultsFor('feed').sort).toBe('newest')
    expect(buildPath({ page: 'feed', sort: 'newest' })).toBe('/')
    expect(buildPath({ page: 'feed', sort: 'likes' })).toBe('/?sort=likes')
  })

  it("falls back to your feed watch default when nothing's remembered", () => {
    setPageDefaultOverrides({ feed: { watch: [] } })
    expect(loadWatchStatuses()).toEqual([])
  })
})
