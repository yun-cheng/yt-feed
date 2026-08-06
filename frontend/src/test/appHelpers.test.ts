import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { filterWatchLater, sortWatchLater, buildPath, pageFilters } from '../App'
import type { VideoItem } from '../App'

function makeVideo(overrides: Partial<VideoItem> = {}): VideoItem {
  return {
    youtube_id: 'v1',
    title: 'Title',
    channel_id: 'c1',
    thumbnail_url: '',
    published_at: new Date().toISOString(),
    view_count: 1000,
    like_count: 100,
    duration_seconds: 60,
    score: 10,
    ...overrides,
  }
}

// ── filterWatchLater ─────────────────────────────────────────

describe('filterWatchLater', () => {
  const NOW = new Date('2024-06-01T12:00:00Z').getTime()

  beforeEach(() => { vi.setSystemTime(NOW) })
  afterEach(() => { vi.useRealTimers() })

  it('keeps videos inside the window and drops the rest', () => {
    const recent = makeVideo({ published_at: new Date(NOW - 1 * 3600_000).toISOString() }) // 1h ago
    const old    = makeVideo({ youtube_id: 'v2', published_at: new Date(NOW - 100 * 3600_000).toISOString() }) // 100h ago
    const result = filterWatchLater([recent, old], { lo: 0, hi: 2 }) // 0–3d = 0–72h
    expect(result).toHaveLength(1)
    expect(result[0].youtube_id).toBe('v1')
  })

  it('excludes videos older than the window', () => {
    const old = makeVideo({ published_at: new Date(NOW - 200 * 3600_000).toISOString() })
    expect(filterWatchLater([old], { lo: 0, hi: 3 })).toHaveLength(0)
  })

  // The old narrow mode never applied its recent edge here, so a range that
  // starts away from now behaved exactly like one that didn't.
  it('excludes videos newer than the recent edge', () => {
    const recent = makeVideo({ published_at: new Date(NOW - 1 * 3600_000).toISOString() }) // 1h ago
    const mid    = makeVideo({ youtube_id: 'v2', published_at: new Date(NOW - 100 * 3600_000).toISOString() }) // ~4d ago
    const result = filterWatchLater([recent, mid], { lo: 2, hi: 4 }) // 3d–2w ago
    expect(result).toHaveLength(1)
    expect(result[0].youtube_id).toBe('v2')
  })
})

// ── sortWatchLater ───────────────────────────────────────────

describe('sortWatchLater', () => {
  const a = makeVideo({ youtube_id: 'a', view_count: 500, like_count: 50, score: 5, published_at: '2024-01-01T00:00:00Z' })
  const b = makeVideo({ youtube_id: 'b', view_count: 1000, like_count: 200, score: 20, published_at: '2024-03-01T00:00:00Z' })
  const c = makeVideo({ youtube_id: 'c', view_count: 200, like_count: 10, score: 1, published_at: '2024-02-01T00:00:00Z' })

  it('sorts by views descending', () => {
    const result = sortWatchLater([a, b, c], 'views')
    expect(result.map(v => v.youtube_id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts by likes descending', () => {
    const result = sortWatchLater([a, b, c], 'likes')
    expect(result.map(v => v.youtube_id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts by score descending', () => {
    const result = sortWatchLater([a, b, c], 'score')
    expect(result.map(v => v.youtube_id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts by like% descending', () => {
    // a: 50/500=10%, b: 200/1000=20%, c: 10/200=5%
    const result = sortWatchLater([a, b, c], 'like%')
    expect(result.map(v => v.youtube_id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts by newest (published_at desc)', () => {
    const result = sortWatchLater([a, b, c], 'newest')
    expect(result.map(v => v.youtube_id)).toEqual(['b', 'c', 'a'])
  })

  it('sorts by oldest (published_at asc)', () => {
    const result = sortWatchLater([a, b, c], 'oldest')
    expect(result.map(v => v.youtube_id)).toEqual(['a', 'c', 'b'])
  })

  it('returns videos unchanged for unknown sort', () => {
    const result = sortWatchLater([a, b, c], 'unknown')
    expect(result.map(v => v.youtube_id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the input array', () => {
    const input = [b, a, c]
    sortWatchLater(input, 'views')
    expect(input.map(v => v.youtube_id)).toEqual(['b', 'a', 'c'])
  })
})

// ── buildPath ────────────────────────────────────────────────

describe('buildPath', () => {
  it('returns / for feed with defaults', () => {
    expect(buildPath({ page: 'feed', age: { lo: 0, hi: 2 }, sort: 'likes' })).toBe('/')
  })

  it('includes non-default window in query string', () => {
    expect(buildPath({ page: 'feed', age: { lo: 0, hi: 3 } })).toBe('/?age=0-7')
  })

  it('writes a window that the old two-param spelling could not express', () => {
    expect(buildPath({ page: 'feed', age: { lo: 2, hi: 4 } })).toBe('/?age=3-14')
  })

  it('includes non-default sort in query string', () => {
    expect(buildPath({ page: 'feed', sort: 'views' })).toBe('/?sort=views')
  })

  it('includes tags in query string', () => {
    expect(buildPath({ page: 'feed', tags: ['coding', 'music'] })).toBe('/?tags=coding%2Cmusic')
  })

  it('returns /channels for channels page', () => {
    expect(buildPath({ page: 'channels', sort: 'subs' })).toBe('/channels')
  })

  it('includes a non-default channels sort', () => {
    expect(buildPath({ page: 'channels', sort: 'alpha' })).toBe('/channels?sort=alpha')
  })

  it('returns /watchlater for watchlater page', () => {
    expect(buildPath({ page: 'watchlater' })).toBe('/watchlater')
  })

  it('returns /channel/:id for channel page', () => {
    expect(buildPath({ page: 'channel', channelId: 'UC123' })).toBe('/channel/UC123')
  })

  it('writes a window that starts away from now', () => {
    expect(buildPath({ page: 'feed', age: { lo: 1, hi: 2 } })).toBe('/?age=1-3')
  })

  // Each page's defaults differ, so the same value can be default on one page
  // and worth writing on another.
  it('omits the channel page defaults but writes the feed ones', () => {
    expect(buildPath({ page: 'channel', channelId: 'UC1', age: { lo: 0, hi: 5 }, sort: 'likes' })).toBe('/channel/UC1')
    expect(buildPath({ page: 'channel', channelId: 'UC1', age: { lo: 0, hi: 2 } })).toBe('/channel/UC1?age=0-3')
  })

  it('omits sort and window on pages that have no such control', () => {
    expect(buildPath({ page: 'downloads', sort: 'views', age: { lo: 0, hi: 3 } })).toBe('/downloads')
    expect(buildPath({ page: 'history', age: { lo: 0, hi: 3 }, sort: 'views' })).toBe('/history?sort=views')
  })

  it('writes the watch-status filter only when it differs from the page default', () => {
    expect(buildPath({ page: 'feed', watch: ['unwatched', 'in_progress'] })).toBe('/')
    expect(buildPath({ page: 'feed', watch: ['watched'] })).toBe('/?watch=watched')
    // Empty means "no filter", which is not the same as the param being absent.
    expect(buildPath({ page: 'feed', watch: [] })).toBe('/?watch=none')
    // History and channel pages default to no filter, so empty writes nothing.
    expect(buildPath({ page: 'history', watch: [] })).toBe('/history')
    expect(buildPath({ page: 'history', watch: ['watched'] })).toBe('/history?watch=watched')
  })

  it('writes tags only on pages that filter by them', () => {
    expect(buildPath({ page: 'history', tags: ['music'] })).toBe('/history?tags=music')
    expect(buildPath({ page: 'downloads', tags: ['music'] })).toBe('/downloads')
    expect(buildPath({ page: 'imported', tags: ['music'] })).toBe('/imported')
  })

  it('writes shorts, label, hidden and q only where they apply', () => {
    expect(buildPath({ page: 'feed', shorts: true })).toBe('/?shorts=1')
    expect(buildPath({ page: 'imported', shorts: true })).toBe('/imported')
    expect(buildPath({ page: 'channel', channelId: 'UC1', label: 'piano' })).toBe('/channel/UC1?label=piano')
    expect(buildPath({ page: 'feed', label: 'piano' })).toBe('/')
    expect(buildPath({ page: 'feed', showHidden: true })).toBe('/?hidden=1')
    expect(buildPath({ page: 'search', q: 'jazz' })).toBe('/search?q=jazz')
  })
})

// ── pageFilters ──────────────────────────────────────────────

// The sidebar renders from this, and buildPath writes from the same sets, so a
// filter is either usable AND in the URL, or in neither.
describe('pageFilters', () => {
  const on = (page: string) =>
    Object.entries(pageFilters(page)).filter(([, v]) => v).map(([k]) => k).sort()

  it('offers every filter on the feed', () => {
    expect(on('feed')).toEqual(['contentMode', 'hidden', 'tags', 'watchStatus'])
  })

  it('drops the watch status where there are no videos to filter', () => {
    // A list of channels, not of videos.
    expect(on('channels')).toEqual(['tags'])
  })

  it('leaves the Imported page with only the watch status', () => {
    // Imported videos come from channels you don't follow, so no tag matches
    // them, and the page is one flat list — no Videos/Shorts split.
    expect(on('imported')).toEqual(['watchStatus'])
  })

  it('offers nothing on pages with no filterable list', () => {
    expect(on('downloads')).toEqual([])
    expect(on('playlists')).toEqual([])
    expect(on('search')).toEqual([])
  })

  it('swaps tags for the channel page (which shows topics instead)', () => {
    expect(on('channel')).toEqual(['contentMode', 'watchStatus'])
  })
})
