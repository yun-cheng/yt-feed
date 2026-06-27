import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { filterWatchLater, sortWatchLater, buildPath } from '../App'
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

  it('returns all videos when window is unrecognised', () => {
    const videos = [makeVideo(), makeVideo({ youtube_id: 'v2' })]
    expect(filterWatchLater(videos, 'bad', 'wide')).toHaveLength(2)
  })

  it('wide mode: keeps videos within the window', () => {
    const recent = makeVideo({ published_at: new Date(NOW - 1 * 3600_000).toISOString() }) // 1h ago
    const old    = makeVideo({ youtube_id: 'v2', published_at: new Date(NOW - 100 * 3600_000).toISOString() }) // 100h ago
    const result = filterWatchLater([recent, old], '3d', 'wide') // 3d = 72h
    expect(result).toHaveLength(1)
    expect(result[0].youtube_id).toBe('v1')
  })

  it('wide mode: excludes videos older than the window', () => {
    const old = makeVideo({ published_at: new Date(NOW - 200 * 3600_000).toISOString() })
    expect(filterWatchLater([old], '1w', 'wide')).toHaveLength(0)
  })

  it('narrow mode: same cutoff as wide (keeps videos within the window)', () => {
    // frontend narrow mode is t >= cutoff && t <= now — same behaviour as wide
    const recent = makeVideo({ published_at: new Date(NOW - 1 * 3600_000).toISOString() }) // 1h ago
    const old    = makeVideo({ youtube_id: 'v2', published_at: new Date(NOW - 100 * 3600_000).toISOString() }) // 100h ago — beyond 72h
    const result = filterWatchLater([recent, old], '3d', 'narrow')
    expect(result).toHaveLength(1)
    expect(result[0].youtube_id).toBe('v1')
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
    expect(buildPath('feed', null, [], '3d', 'likes', 'wide', 'subs')).toBe('/')
  })

  it('includes non-default window in query string', () => {
    expect(buildPath('feed', null, [], '1w', 'likes', 'wide', 'subs')).toBe('/?window=1w')
  })

  it('includes non-default sort in query string', () => {
    expect(buildPath('feed', null, [], '3d', 'views', 'wide', 'subs')).toBe('/?sort=views')
  })

  it('includes tags in query string', () => {
    const path = buildPath('feed', null, ['coding', 'music'], '3d', 'likes', 'wide', 'subs')
    expect(path).toBe('/?tags=coding%2Cmusic')
  })

  it('returns /channels for channels page', () => {
    expect(buildPath('channels', null, [], '3d', 'likes', 'wide', 'subs')).toBe('/channels')
  })

  it('uses channelsSort (not sort) on channels page', () => {
    expect(buildPath('channels', null, [], '3d', 'likes', 'wide', 'alpha')).toBe('/channels?sort=alpha')
  })

  it('returns /watchlater for watchlater page', () => {
    expect(buildPath('watchlater', null, [], '3d', 'likes', 'wide', 'subs')).toBe('/watchlater')
  })

  it('returns /channel/:id for channel page', () => {
    expect(buildPath('channel', 'UC123', [], '3d', 'likes', 'wide', 'subs')).toBe('/channel/UC123')
  })

  it('includes timeMode in query string when narrow', () => {
    expect(buildPath('feed', null, [], '3d', 'likes', 'narrow', 'subs')).toBe('/?time_mode=narrow')
  })
})
