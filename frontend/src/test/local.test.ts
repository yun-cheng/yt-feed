import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchFolders, fetchFolderVideos, formatSize, watchedRatio } from '../lib/local'
import type { LocalVideo } from '../lib/local'

function video(over: Partial<LocalVideo> = {}): LocalVideo {
  return {
    id: 'abc', folder_id: 1, title: 'A clip', rel_path: 'a.mp4', sub_dir: '',
    duration_seconds: 600, probed: true, filesize: 1000, modified_at: '',
    position_seconds: 0, watched: false, file_url: '', thumbnail_url: '',
    ...over,
  }
}

describe('watchedRatio', () => {
  it('is zero for an untouched video', () => {
    expect(watchedRatio(video())).toBe(0)
  })

  it('is the fraction watched', () => {
    expect(watchedRatio(video({ position_seconds: 150 }))).toBe(0.25)
  })

  it('is a full bar once the video is marked watched, wherever the position is', () => {
    // The position lands short of the end (credits skipped, or the tail rule
    // fired), but the card should read as finished.
    expect(watchedRatio(video({ watched: true, position_seconds: 10 }))).toBe(1)
  })

  it('never exceeds a full bar', () => {
    // A stale duration can be shorter than the position the player reported.
    expect(watchedRatio(video({ position_seconds: 900, duration_seconds: 600 }))).toBe(1)
  })

  it('is zero when the duration is not known yet', () => {
    // An unprobed video reports 0 — dividing by it would give Infinity and
    // paint a full bar on a video nobody has watched.
    expect(watchedRatio(video({ duration_seconds: 0, position_seconds: 30 }))).toBe(0)
  })
})

describe('formatSize', () => {
  it('picks the unit that keeps the number short', () => {
    expect(formatSize(999)).toBe('999 B')
    expect(formatSize(1_000)).toBe('1 KB')
    expect(formatSize(1_500_000)).toBe('2 MB')
    expect(formatSize(1_500_000_000)).toBe('1.5 GB')
  })

  it('shows a decimal only for gigabytes', () => {
    // Below a GB the extra digit is noise; above it, 4 GB vs 4.7 GB matters.
    expect(formatSize(4_700_000_000)).toBe('4.7 GB')
    expect(formatSize(4_700_000)).toBe('5 MB')
  })

  it('handles an empty file', () => {
    expect(formatSize(0)).toBe('0 B')
  })
})

describe('fetch helpers', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals() })

  const ok = (body: unknown) => ({ ok: true, json: async () => body }) as Response
  const fail = () => ({ ok: false, status: 500, clone: () => ({ text: async () => '' }) }) as unknown as Response

  it('fetchFolders returns the folder list', async () => {
    vi.mocked(fetch).mockResolvedValue(ok([{ id: 1, name: 'Clips' }]))
    expect(await fetchFolders()).toEqual([{ id: 1, name: 'Clips' }])
    expect(fetch).toHaveBeenCalledWith('/api/local/folders', {})
  })

  it('fetchFolders degrades to an empty list rather than throwing', async () => {
    vi.mocked(fetch).mockResolvedValue(fail())
    expect(await fetchFolders()).toEqual([])
  })

  it('fetchFolderVideos rescans by default', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ folder: {}, videos: [], scanning: false }))
    await fetchFolderVideos(3)
    expect(fetch).toHaveBeenCalledWith('/api/local/folders/3/videos?rescan=true', {})
  })

  it('the polling call skips the rescan and stays quiet', async () => {
    // The page polls this while durations are measured; a toast per failure
    // would be noise, and re-walking the directory each time would be waste.
    vi.mocked(fetch).mockResolvedValue(ok({ folder: {}, videos: [], scanning: true }))
    await fetchFolderVideos(3, false)
    expect(fetch).toHaveBeenCalledWith('/api/local/folders/3/videos?rescan=false', {})
  })

  it('fetchFolderVideos returns null when the folder is gone', async () => {
    vi.mocked(fetch).mockResolvedValue(fail())
    expect(await fetchFolderVideos(3)).toBeNull()
  })
})
