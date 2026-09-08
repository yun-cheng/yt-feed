import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { filterByTime, filterBySummarised, filterByTags, setTagState, isExcluded, tagName, sortVideos, buildPath, pageFilters, parseStartAt, watchStatusOf, filterByWatchStatus, loadWatchStatuses, WATCH_STATUSES, DEFAULT_WATCH_STATUSES } from '../App'
import type { TagInfo } from '../App'
import type { VideoItem, WatchProgress } from '../App'

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

// ── filterByTime ─────────────────────────────────────────────

describe('filterByTime', () => {
  const NOW = new Date('2024-06-01T12:00:00Z').getTime()
  const published = (v: VideoItem) => v.published_at

  beforeEach(() => { vi.setSystemTime(NOW) })
  afterEach(() => { vi.useRealTimers() })

  it('keeps videos inside the window and drops the rest', () => {
    const recent = makeVideo({ published_at: new Date(NOW - 1 * 3600_000).toISOString() }) // 1h ago
    const old    = makeVideo({ youtube_id: 'v2', published_at: new Date(NOW - 100 * 3600_000).toISOString() }) // 100h ago
    const result = filterByTime([recent, old], { lo: 0, hi: 2 }, published) // 0–3d = 0–72h
    expect(result).toHaveLength(1)
    expect(result[0].youtube_id).toBe('v1')
  })

  it('excludes videos older than the window', () => {
    const old = makeVideo({ published_at: new Date(NOW - 200 * 3600_000).toISOString() })
    expect(filterByTime([old], { lo: 0, hi: 3 }, published)).toHaveLength(0)
  })

  // The old narrow mode never applied its recent edge here, so a range that
  // starts away from now behaved exactly like one that didn't.
  it('excludes videos newer than the recent edge', () => {
    const recent = makeVideo({ published_at: new Date(NOW - 1 * 3600_000).toISOString() }) // 1h ago
    const mid    = makeVideo({ youtube_id: 'v2', published_at: new Date(NOW - 100 * 3600_000).toISOString() }) // ~4d ago
    const result = filterByTime([recent, mid], { lo: 2, hi: 4 }, published) // 3d–2w ago
    expect(result).toHaveLength(1)
    expect(result[0].youtube_id).toBe('v2')
  })

  // The whole point of the per-page stamp: a library page windows by when the
  // row joined the list, and a video published years ago can have joined today.
  it('windows by the stamp it is given, not by publish date', () => {
    const v = makeVideo({
      published_at: '2015-01-01T00:00:00Z',
      created_at: new Date(NOW - 3600_000).toISOString(),
    })
    expect(filterByTime([v], { lo: 0, hi: 1 }, x => x.created_at)).toHaveLength(1)
    expect(filterByTime([v], { lo: 0, hi: 1 }, published)).toHaveLength(0)
  })

  // The API writes `datetime.utcnow().isoformat()` — no zone on it. Read as
  // local time it would land hours out, enough to fall out of a 1d window.
  it('reads a zoneless stamp as UTC', () => {
    const v = makeVideo({ created_at: new Date(NOW - 3600_000).toISOString().replace('Z', '') })
    expect(filterByTime([v], { lo: 0, hi: 1 }, x => x.created_at)).toHaveLength(1)
  })

  // Missing means the field predates the row, not that the row is infinitely
  // old — dropping it would hide it even at "All time".
  it('keeps a row that has no stamp at all', () => {
    const v = makeVideo({ created_at: null })
    expect(filterByTime([v], { lo: 0, hi: 1 }, x => x.created_at)).toHaveLength(1)
    expect(filterByTime([v], { lo: 0, hi: 9 }, x => x.created_at)).toHaveLength(1)
  })
})

// ── sortVideos ───────────────────────────────────────────

describe('sortVideos', () => {
  const a = makeVideo({ youtube_id: 'a', view_count: 500, like_count: 50, score: 5, published_at: '2024-01-01T00:00:00Z' })
  const b = makeVideo({ youtube_id: 'b', view_count: 1000, like_count: 200, score: 20, published_at: '2024-03-01T00:00:00Z' })
  const c = makeVideo({ youtube_id: 'c', view_count: 200, like_count: 10, score: 1, published_at: '2024-02-01T00:00:00Z' })

  it('sorts by views descending', () => {
    const result = sortVideos([a, b, c], 'views')
    expect(result.map(v => v.youtube_id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts by likes descending', () => {
    const result = sortVideos([a, b, c], 'likes')
    expect(result.map(v => v.youtube_id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts by score descending', () => {
    const result = sortVideos([a, b, c], 'score')
    expect(result.map(v => v.youtube_id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts by like% descending', () => {
    // a: 50/500=10%, b: 200/1000=20%, c: 10/200=5%
    const result = sortVideos([a, b, c], 'like%')
    expect(result.map(v => v.youtube_id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts by newest (published_at desc)', () => {
    const result = sortVideos([a, b, c], 'newest')
    expect(result.map(v => v.youtube_id)).toEqual(['b', 'c', 'a'])
  })

  it('sorts by oldest (published_at asc)', () => {
    const result = sortVideos([a, b, c], 'oldest')
    expect(result.map(v => v.youtube_id)).toEqual(['a', 'c', 'b'])
  })

  it('returns videos unchanged for unknown sort', () => {
    const result = sortVideos([a, b, c], 'unknown')
    expect(result.map(v => v.youtube_id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the input array', () => {
    const input = [b, a, c]
    sortVideos(input, 'views')
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
    expect(buildPath({ page: 'playlists', sort: 'views', age: { lo: 0, hi: 3 } })).toBe('/playlists')
    expect(buildPath({ page: 'local', sort: 'views', age: { lo: 0, hi: 3 } })).toBe('/local')
  })

  // The library pages open on all time and on their own order, so those two
  // values are the ones left out of the URL — a three-day window is now the
  // unusual thing to say there, and gets written.
  it('treats all-time and list order as the library default', () => {
    for (const page of ['watchlater', 'imported', 'downloads', 'history']) {
      expect(buildPath({ page, age: { lo: 0, hi: 9 }, sort: 'recent' })).toBe(`/${page}`)
      expect(buildPath({ page, age: { lo: 0, hi: 2 }, sort: 'recent' })).toBe(`/${page}?age=0-3`)
      expect(buildPath({ page, age: { lo: 0, hi: 9 }, sort: 'views' })).toBe(`/${page}?sort=views`)
    }
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

  // A search confined to one channel is that channel's page filtered by text,
  // so the query rides on the channel URL — and the page it sits on is what
  // says whether a `q` is a search or a scoped one.
  it('carries a query on the search page and on a channel page', () => {
    expect(buildPath({ page: 'channel', channelId: 'UC1', q: 'jazz' })).toBe('/channel/UC1?q=jazz')
    expect(buildPath({ page: 'feed', q: 'jazz' })).toBe('/')
    expect(buildPath({ page: 'watchlater', q: 'jazz' })).toBe('/watchlater')
  })
})

// ── pageFilters ──────────────────────────────────────────────

// The sidebar renders from this, and buildPath writes from the same sets, so a
// filter is either usable AND in the URL, or in neither.
describe('pageFilters', () => {
  const on = (page: string) =>
    Object.entries(pageFilters(page)).filter(([, v]) => v).map(([k]) => k).sort()

  it('offers every filter on the feed', () => {
    expect(on('feed')).toEqual(['contentMode', 'hidden', 'summarised', 'tags', 'watchStatus'])
  })

  it('drops the watch status where there are no videos to filter', () => {
    // A list of channels, not of videos.
    expect(on('channels')).toEqual(['tags'])
  })

  it('leaves the Imported page with only the watch status', () => {
    // Imported videos come from channels you don't follow, so no tag matches
    // them, and the page is one flat list — no Videos/Shorts split.
    expect(on('imported')).toEqual(['summarised', 'watchStatus'])
  })

  it('offers the summary filter wherever videos are listed, and nowhere else', () => {
    // Not on `channels`: it lists channels, and a channel has no summary.
    expect(on('channels')).not.toContain('summarised')
    expect(on('history')).toContain('summarised')
    expect(on('watchlater')).toContain('summarised')
    expect(on('playlist')).toContain('summarised')
  })

  it('offers nothing on pages with no filterable list', () => {
    expect(on('downloads')).toEqual([])
    expect(on('playlists')).toEqual([])
    expect(on('search')).toEqual([])
  })

  it('swaps tags for the channel page (which shows topics instead)', () => {
    expect(on('channel')).toEqual(['contentMode', 'summarised', 'watchStatus'])
  })
})

describe('parseStartAt', () => {
  it('reads whole seconds off ?t=', () => {
    expect(parseStartAt('?t=125')).toBe(125)
    // Zero is a real answer, not an absent one — the caller decides what to do
    // with "start at the top", and `null` would silently mean something else.
    expect(parseStartAt('?t=0')).toBe(0)
  })

  it('is absent when the URL says nothing', () => {
    expect(parseStartAt('')).toBeNull()
    expect(parseStartAt('?sort=views')).toBeNull()
  })

  // A timestamp we only half understand would start at 0 while looking like it
  // worked, which is worse than ignoring it. Nothing that links here writes
  // YouTube's own `1m30s` spelling.
  it.each(['?t=1m30s', '?t=90s', '?t=abc', '?t=', '?t=12.5', '?t=-30'])(
    'ignores %s rather than guessing', (search) => {
      expect(parseStartAt(search)).toBeNull()
    })
})

// ── one playlist's own filters ───────────────────────────────

describe('buildPath — a playlist keeps its id and its filters', () => {
  it('carries the id, like a channel page does', () => {
    expect(buildPath({ page: 'playlist', playlistId: 5 })).toBe('/playlist/5')
  })

  it('puts the sort in the query beside it, so a refresh keeps it', () => {
    expect(buildPath({ page: 'playlist', playlistId: 5, sort: 'views' }))
      .toBe('/playlist/5?sort=views')
  })

  it("leaves the playlist's own order out — that's the default", () => {
    expect(buildPath({ page: 'playlist', playlistId: 5, sort: 'recent' }))
      .toBe('/playlist/5')
  })

  it('carries a window that differs from all-time', () => {
    expect(buildPath({ page: 'playlist', playlistId: 5, age: { lo: 0, hi: 3 } }))
      .toBe('/playlist/5?age=0-7')
  })

  it('falls back to /playlist when there is no id to name', () => {
    expect(buildPath({ page: 'playlist' })).toBe('/playlist')
  })
})

describe('pageFilters — what a playlist puts in the sidebar', () => {
  it('offers watch status, so "what have I not seen here" is one click', () => {
    expect(pageFilters('playlist').watchStatus).toBe(true)
  })

  it('offers no tags: a playlist can hold channels you do not follow', () => {
    expect(pageFilters('playlist').tags).toBe(false)
  })

  it('the playlists grid offers neither — it lists playlists, not videos', () => {
    const f = pageFilters('playlists')
    expect(f.watchStatus).toBe(false)
    expect(f.tags).toBe(false)
  })
})

// ── the axis a playlist windows on ───────────────────────────

describe('a playlist windows by publish date, not by when it was imported', () => {
  const NOW = new Date('2024-06-01T12:00:00Z').getTime()
  beforeEach(() => { vi.setSystemTime(NOW) })
  afterEach(() => { vi.useRealTimers() })

  // What an import actually writes: every row stamped within the same second,
  // spaced only enough to preserve YouTube's order.
  const imported = [
    makeVideo({ youtube_id: 'new', published_at: '2024-05-30T00:00:00Z',
                created_at: '2024-06-01T11:59:59' }),
    makeVideo({ youtube_id: 'mid', published_at: '2024-05-01T00:00:00Z',
                created_at: '2024-06-01T11:59:58' }),
    makeVideo({ youtube_id: 'old', published_at: '2021-01-01T00:00:00Z',
                created_at: '2024-06-01T11:59:57' }),
  ]

  it('separates them by age, which is the question worth asking', () => {
    const week = filterByTime(imported, { lo: 0, hi: 3 }, v => v.published_at)
    expect(week.map(v => v.youtube_id)).toEqual(['new'])
  })

  it('and the other end of the ladder answers too', () => {
    const older = filterByTime(imported, { lo: 4, hi: 9 }, v => v.published_at)
    expect(older.map(v => v.youtube_id)).toEqual(['mid', 'old'])
  })

  it('whereas the import stamp would answer all-or-nothing, which is no filter', () => {
    // The bug this replaced: every row joined the list at once, so any window
    // either keeps the whole playlist or empties it. Both shown here.
    expect(filterByTime(imported, { lo: 0, hi: 3 }, v => v.created_at)).toHaveLength(3)
    expect(filterByTime(imported, { lo: 4, hi: 9 }, v => v.created_at)).toHaveLength(0)
  })
})

// ── the summarised filter ────────────────────────────────────

describe('filterBySummarised', () => {
  const list = [
    makeVideo({ youtube_id: 'has' }),
    makeVideo({ youtube_id: 'hasnt' }),
  ]
  const summarised = new Set(['has'])

  it('leaves the list alone until it is switched on', () => {
    // Off is the ordinary case, and a filter that quietly narrowed anything
    // while off would be the worst kind of bug to notice.
    expect(filterBySummarised(list, false, summarised)).toBe(list)
  })

  it('keeps only what has a summary', () => {
    expect(filterBySummarised(list, true, summarised).map(v => v.youtube_id)).toEqual(['has'])
  })

  it('can empty a list, and says so by being empty', () => {
    // Unlike the watch-status filter, "nothing selected" isn't a thing here —
    // one direction, so an empty result means you have no summaries in view
    // rather than a filter that fell through to showing everything.
    expect(filterBySummarised(list, true, new Set())).toEqual([])
  })
})

describe('buildPath — the summarised filter rides in the URL', () => {
  it('is absent when off, so an ordinary feed link stays clean', () => {
    expect(buildPath({ page: 'feed', summarised: false })).toBe('/')
  })

  it('is carried when on, so the link shows what you were looking at', () => {
    expect(buildPath({ page: 'feed', summarised: true })).toBe('/?summarised=1')
  })

  it('is dropped on a page that cannot use it', () => {
    expect(buildPath({ page: 'channels', summarised: true })).toBe('/channels')
  })
})

// ── for, against, or neither ─────────────────────────────────

describe('setTagState', () => {
  const only = (sel: string[], tag: string) => setTagState(sel, tag, false)
  const not = (sel: string[], tag: string) => setTagState(sel, tag, true)

  it('each half sets its own state from nothing', () => {
    expect(only([], 'chinese')).toEqual(['chinese'])
    expect(not([], 'chinese')).toEqual(['-chinese'])
  })

  it('each half is its own undo', () => {
    // The point of splitting the chip: neither meaning is reached by cycling
    // past the other, and neither is cleared by passing through it.
    expect(only(['chinese'], 'chinese')).toEqual([])
    expect(not(['-chinese'], 'chinese')).toEqual([])
  })

  it('switches sides without a stop in between', () => {
    expect(not(['chinese'], 'chinese')).toEqual(['-chinese'])
    expect(only(['-chinese'], 'chinese')).toEqual(['chinese'])
  })

  it('flips in place, so the filter pills do not reshuffle under the cursor', () => {
    expect(not(['piano', 'chinese', 'ai'], 'chinese')).toEqual(['piano', '-chinese', 'ai'])
  })

  it('leaves the other tags alone', () => {
    expect(only(['piano'], 'chinese')).toEqual(['piano', 'chinese'])
    expect(not(['-piano', 'chinese'], 'chinese')).toEqual(['-piano', '-chinese'])
  })
})

describe('isExcluded / tagName', () => {
  it('reads only the first character, since tag names contain hyphens', () => {
    // film-tv, real-estate, language-learning — all ordinary inclusions.
    expect(isExcluded('film-tv')).toBe(false)
    expect(tagName('film-tv')).toBe('film-tv')
    expect(isExcluded('-film-tv')).toBe(true)
    expect(tagName('-film-tv')).toBe('film-tv')
  })
})

describe('filterByTags — excluding', () => {
  const tags: TagInfo[] = [
    { name: 'chinese', group: 'Language', icon: '', channel_count: 0 },
    { name: 'english', group: 'Language', icon: '', channel_count: 0 },
    { name: 'piano', group: 'Music', icon: '', channel_count: 0 },
  ]
  // cn plays Chinese piano, en plays English piano, misc is neither.
  const tagChannels = new Map([
    ['chinese', new Set(['cn'])],
    ['english', new Set(['en'])],
    ['piano', new Set(['cn', 'en'])],
  ])
  const videos = [
    makeVideo({ youtube_id: 'v-cn', channel_id: 'cn' }),
    makeVideo({ youtube_id: 'v-en', channel_id: 'en' }),
    makeVideo({ youtube_id: 'v-misc', channel_id: 'misc' }),
  ]
  const ids = (sel: string[]) =>
    filterByTags(videos, sel, tags, tagChannels).map(v => v.youtube_id)

  it('an exclusion on its own means everything but that', () => {
    // Not an empty page: with nothing selected FOR, there is no positive
    // constraint to intersect against, only a veto to apply.
    expect(ids(['-chinese'])).toEqual(['v-en', 'v-misc'])
  })

  it('vetoes across groups, not within one', () => {
    expect(ids(['piano', '-chinese'])).toEqual(['v-en'])
  })

  it('two exclusions are AND-NOT, not OR-NOT', () => {
    // The reading that folds them into the group rule would leave both in:
    // "not Chinese OR not English" is true of everything.
    expect(ids(['-chinese', '-english'])).toEqual(['v-misc'])
  })

  it('an exclusion beats an inclusion that would have kept it', () => {
    expect(ids(['piano', '-chinese', '-english'])).toEqual([])
  })

  it('is unchanged when nothing is crossed out', () => {
    expect(ids(['piano'])).toEqual(['v-cn', 'v-en'])
    expect(ids([])).toEqual(['v-cn', 'v-en', 'v-misc'])
  })
})

describe('buildPath — an exclusion survives the URL', () => {
  it('carries the minus sign', () => {
    expect(buildPath({ page: 'feed', tags: ['piano', '-chinese'] }))
      .toBe('/?tags=piano%2C-chinese')
  })
})

// ── The watch-status filter ──────────────────────────────────
//
// Three states derived from one progress row: nothing recorded is unwatched,
// a row that isn't finished is in progress, a finished one is watched. The
// filter is the sidebar's chips applied to an already-loaded list — the same
// answer the backend gives the paged ones, so a page can switch between them
// without the list changing meaning.

describe('watchStatusOf', () => {
  const progress = new Map<string, WatchProgress>([
    ['started', { position_seconds: 42, watched: false }],
    ['finished', { position_seconds: 600, watched: true }],
  ])

  it('calls a video with no row unwatched — nothing recorded is nothing seen', () => {
    expect(watchStatusOf('never-opened', progress)).toBe('unwatched')
  })

  it('calls an unfinished row in progress', () => {
    expect(watchStatusOf('started', progress)).toBe('in_progress')
  })

  it('calls a finished row watched, wherever it was left', () => {
    expect(watchStatusOf('finished', progress)).toBe('watched')
  })

  it('reads the flag rather than the position: watched at 0s is still watched', () => {
    const m = new Map<string, WatchProgress>([['v', { position_seconds: 0, watched: true }]])
    expect(watchStatusOf('v', m)).toBe('watched')
  })
})

describe('filterByWatchStatus', () => {
  const videos = [
    makeVideo({ youtube_id: 'never' }),
    makeVideo({ youtube_id: 'started' }),
    makeVideo({ youtube_id: 'finished' }),
  ]
  const progress = new Map<string, WatchProgress>([
    ['started', { position_seconds: 42, watched: false }],
    ['finished', { position_seconds: 600, watched: true }],
  ])
  const ids = (statuses: string[]) =>
    filterByWatchStatus(videos, statuses, progress).map(v => v.youtube_id)

  it('keeps only the statuses selected', () => {
    expect(ids(['unwatched'])).toEqual(['never'])
    expect(ids(['unwatched', 'in_progress'])).toEqual(['never', 'started'])
    expect(ids(['watched'])).toEqual(['finished'])
  })

  it('treats an empty selection as no filter, never as a blank page', () => {
    // Matching the tag filter and the backend's `watch` param: unselecting
    // everything can't leave you staring at nothing wondering why.
    expect(ids([])).toEqual(['never', 'started', 'finished'])
  })

  it('treats every status selected as no filter either', () => {
    expect(ids(WATCH_STATUSES.map(w => w.value))).toEqual(['never', 'started', 'finished'])
  })

  it('leaves the input array alone', () => {
    const before = [...videos]
    filterByWatchStatus(videos, ['watched'], progress)
    expect(videos).toEqual(before)
  })
})

describe('loadWatchStatuses', () => {
  afterEach(() => { localStorage.clear() })

  it('falls back to the default when nothing was ever chosen', () => {
    expect(loadWatchStatuses()).toEqual(DEFAULT_WATCH_STATUSES)
  })

  it('remembers the last choice, empty included — that is a choice too', () => {
    localStorage.setItem('watch_statuses', JSON.stringify(['watched']))
    expect(loadWatchStatuses()).toEqual(['watched'])
    localStorage.setItem('watch_statuses', JSON.stringify([]))
    expect(loadWatchStatuses()).toEqual([])
  })

  it('ignores a value that is not a list of names', () => {
    // Hand-edited storage, or a key from an older shape. The default is a
    // working feed; a bad parse shouldn't be a crash on load.
    localStorage.setItem('watch_statuses', 'not json')
    expect(loadWatchStatuses()).toEqual(DEFAULT_WATCH_STATUSES)
    localStorage.setItem('watch_statuses', JSON.stringify([1, 2]))
    expect(loadWatchStatuses()).toEqual(DEFAULT_WATCH_STATUSES)
  })
})
