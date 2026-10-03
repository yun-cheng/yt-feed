import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import VideoCard from '../components/VideoCard'
import type { VideoItem } from '../App'
import { loadSummaries, _resetSummaries } from '../hooks/summaryStore'
import { loadPlaylistMemberships, _resetPlaylistMemberships } from '../hooks/playlistStore'
import { loadCardNotes, rememberNotes, _resetCardNotes } from '../hooks/notesStore'

const mockVideo: VideoItem = {
  youtube_id: 'abc123',
  title: 'Test Video Title',
  channel_id: 'chan1',
  channel_name: 'Test Channel',
  thumbnail_url: 'https://img.youtube.com/vi/abc123/hqdefault.jpg',
  published_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), // 2h ago
  view_count: 1_500_000,
  like_count: 75_000,
  duration_seconds: 1234,
  score: 450.5,
}

beforeAll(() => {
  window.open = vi.fn()
})

describe('VideoCard', () => {
  it('renders video title', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText('Test Video Title')).toBeInTheDocument()
  })

  it('renders channel name', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText('Test Channel')).toBeInTheDocument()
  })

  it('formats view count in millions', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText(/1\.5M views/)).toBeInTheDocument()
  })

  it('formats duration correctly', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    // 1234s = 20:34
    expect(screen.getByText('20:34')).toBeInTheDocument()
  })

  it('shows relative time', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText(/2h ago/)).toBeInTheDocument()
  })

  it('shows score', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText(/450\.5/)).toBeInTheDocument()
  })

  it('shows thumbnail when not hovered', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    const img = screen.getByRole('img', { name: 'Test Video Title' })
    expect(img).toBeVisible()
  })

  it('calls onHover with video id on mouse enter', () => {
    const onHover = vi.fn()
    render(<VideoCard video={mockVideo} isHovered={false} onHover={onHover} onChannelClick={vi.fn()} />)
    fireEvent.mouseEnter(screen.getByRole('img', { name: 'Test Video Title' }).closest('.relative')!)
    expect(onHover).toHaveBeenCalledWith('abc123')
  })

  it('calls onHover with null on mouse leave', () => {
    const onHover = vi.fn()
    render(<VideoCard video={mockVideo} isHovered={false} onHover={onHover} onChannelClick={vi.fn()} />)
    fireEvent.mouseLeave(screen.getByRole('img', { name: 'Test Video Title' }).closest('.relative')!)
    expect(onHover).toHaveBeenCalledWith(null)
  })

  it('opens the in-app watch page on card click', () => {
    // Dispatched as an app-level event rather than threaded as a callback
    // through every feed surface (VideoRow / Channel / Search / Playlist).
    const onWatch = vi.fn()
    window.addEventListener('app:watch', onWatch)
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    fireEvent.click(screen.getByRole('img', { name: 'Test Video Title' }).closest('.relative')!)
    expect(onWatch).toHaveBeenCalled()
    expect((onWatch.mock.calls[0][0] as CustomEvent).detail).toEqual(mockVideo)
    window.removeEventListener('app:watch', onWatch)
  })

  // Two real anchors carry the title: the transparent one over the thumbnail,
  // and the title text itself.
  const overlayLink = () => screen.getAllByRole('link', { name: 'Test Video Title' })[0]

  it('keeps real YouTube anchors so right-click offers "open in new tab"', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    for (const link of screen.getAllByRole('link', { name: 'Test Video Title' })) {
      expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abc123')
    }
  })

  it('currently opens the watch page on a modifier-click as well as the new tab', () => {
    // Pins a known wrong answer so a fix is a deliberate change, not a surprise.
    // The overlay anchor returns early on a modifier-click so the browser opens
    // YouTube natively — but it doesn't stopPropagation, so the click still
    // reaches the card wrapper's onClick and opens the watch overlay too.
    const onWatch = vi.fn()
    window.addEventListener('app:watch', onWatch)
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    fireEvent.click(overlayLink(), { metaKey: true })
    expect(onWatch).toHaveBeenCalled()
    window.removeEventListener('app:watch', onWatch)
  })

  it.fails('should leave a modifier-click to YouTube alone', () => {
    const onWatch = vi.fn()
    window.addEventListener('app:watch', onWatch)
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    fireEvent.click(overlayLink(), { metaKey: true })
    try {
      expect(onWatch).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('app:watch', onWatch)
    }
  })

  it('opens the watch page on a plain click of the thumbnail overlay', () => {
    const onWatch = vi.fn()
    window.addEventListener('app:watch', onWatch)
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    fireEvent.click(overlayLink())
    expect(onWatch).toHaveBeenCalled()
    window.removeEventListener('app:watch', onWatch)
  })

  it('lets a caller override the open behaviour', () => {
    // Downloads and local files open their own player instead of YouTube's.
    const onOpen = vi.fn()
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('img', { name: 'Test Video Title' }).closest('.relative')!)
    expect(onOpen).toHaveBeenCalledWith(mockVideo)
    // …and drops the YouTube anchor entirely, so there's nothing to cmd-click to.
    expect(screen.queryByRole('link', { name: 'Test Video Title' })).not.toBeInTheDocument()
  })

  it('calls onChannelClick when channel name is clicked', () => {
    const onChannelClick = vi.fn()
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={onChannelClick} />)
    fireEvent.click(screen.getByText('Test Channel'))
    expect(onChannelClick).toHaveBeenCalledWith('chan1')
  })

  it('shows "Unknown" when channel_name is absent', () => {
    const video = { ...mockVideo, channel_name: undefined }
    render(<VideoCard video={video} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText('Unknown')).toBeInTheDocument()
  })

  it('hides duration badge when duration is 0', () => {
    const video = { ...mockVideo, duration_seconds: 0 }
    render(<VideoCard video={video} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    // Duration badge shows MM:SS or H:MM:SS — absence of that specific pattern
    expect(screen.queryByText(/^\d+:\d{2}$/)).not.toBeInTheDocument()
  })
})

describe('VideoCard — Watch Later bookmark', () => {
  it('does not show bookmark button without onToggleWatchLater', () => {
    render(<VideoCard video={mockVideo} isHovered={true} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.queryByTitle(/Watch Later/i)).not.toBeInTheDocument()
  })

  it('shows bookmark button when hovered and onToggleWatchLater provided', () => {
    render(<VideoCard video={mockVideo} isHovered={true} onHover={vi.fn()} onChannelClick={vi.fn()} onToggleWatchLater={vi.fn()} />)
    expect(screen.getByTitle('Save to Watch Later')).toBeInTheDocument()
  })

  it('does not show bookmark button when not hovered and not saved', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} onToggleWatchLater={vi.fn()} />)
    expect(screen.queryByTitle(/Watch Later/i)).not.toBeInTheDocument()
  })

  it('shows filled bookmark when isWatchLater=true even when not hovered', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} isWatchLater={true} onToggleWatchLater={vi.fn()} />)
    expect(screen.getByTitle('Remove from Watch Later')).toBeInTheDocument()
  })

  it('calls onToggleWatchLater with the video when bookmark is clicked', () => {
    const onToggleWatchLater = vi.fn()
    render(<VideoCard video={mockVideo} isHovered={true} onHover={vi.fn()} onChannelClick={vi.fn()} onToggleWatchLater={onToggleWatchLater} />)
    fireEvent.click(screen.getByTitle('Save to Watch Later'))
    expect(onToggleWatchLater).toHaveBeenCalledWith(mockVideo)
  })

  it('bookmark click does not open YouTube (stopPropagation)', () => {
    const onOpen = vi.fn()
    window.open = onOpen
    render(<VideoCard video={mockVideo} isHovered={true} onHover={vi.fn()} onChannelClick={vi.fn()} onToggleWatchLater={vi.fn()} />)
    fireEvent.click(screen.getByTitle('Save to Watch Later'))
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('VideoCard — sort highlighting', () => {
  it('highlights the active sort stat', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} sort="views" />)
    expect(screen.getByText('1.5M views')).toHaveClass('text-white', 'font-medium')
  })

  it('does not highlight other stats when sort=views', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} sort="views" />)
    expect(screen.getByText('75.0K likes')).not.toHaveClass('text-white')
  })

  it('highlights newest stat when sort=oldest', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} sort="oldest" />)
    expect(screen.getByText('2h ago')).toHaveClass('text-white', 'font-medium')
  })

  it('does not highlight any stat when no sort prop', () => {
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    expect(screen.getByText('1.5M views')).not.toHaveClass('text-white')
  })
})

// ── the long summary a card can ask for ──────────────────────────────
//
// The label is the whole point of the feature: the summary is written somewhere
// you are not, so the card has to say what it is doing on its own.

function serveJobs(jobs: { video_id: string; status: string; length?: string }[]) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ jobs }),
    clone: () => ({ text: async () => '' }),
  })) as unknown as typeof fetch
}

const card = () => (
  <VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} />
)

describe('VideoCard summaries', () => {
  afterEach(() => { _resetSummaries(); vi.restoreAllMocks() })

  it('offers both lengths in the more-actions menu', () => {
    render(card())
    fireEvent.click(screen.getByLabelText('More actions'))
    expect(screen.getByText('Short summary')).toBeInTheDocument()
    expect(screen.getByText('Long summary')).toBeInTheDocument()
  })

  it('asking for one labels the card straight away', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ status: 'running', length: 'long' }),
      clone: () => ({ text: async () => '' }),
    })) as unknown as typeof fetch
    render(card())
    fireEvent.click(screen.getByLabelText('More actions'))
    await act(async () => { fireEvent.click(screen.getByText('Long summary')) })
    expect(screen.getByText('Summarising')).toBeInTheDocument()
  })

  it('asks for the length that was clicked', async () => {
    const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true, status: 200, json: async () => ({ status: 'running', length: 'short' }),
      clone: () => ({ text: async () => '' }),
    }))
    globalThis.fetch = fn as unknown as typeof fetch
    render(card())
    fireEvent.click(screen.getByLabelText('More actions'))
    await act(async () => { fireEvent.click(screen.getByText('Short summary')) })
    expect(JSON.parse(String((fn.mock.calls[0][1] as RequestInit).body))).toEqual({ length: 'short' })
  })

  it('says so once the summary is written', async () => {
    serveJobs([{ video_id: 'abc123', status: 'done', length: 'long' }])
    render(card())
    await act(async () => { await loadSummaries() })
    expect(screen.getByText('Summarised')).toBeInTheDocument()
  })

  it('a failure is a visible label, not a silently missing one', async () => {
    serveJobs([{ video_id: 'abc123', status: 'error', length: 'long' }])
    render(card())
    await act(async () => { await loadSummaries() })
    expect(screen.getByText('Summary failed')).toBeInTheDocument()
  })

  it('both entries stay offered once there is a summary — the other length is still worth asking for', async () => {
    serveJobs([{ video_id: 'abc123', status: 'done', length: 'short' }])
    render(card())
    await act(async () => { await loadSummaries() })
    fireEvent.click(screen.getByLabelText('More actions'))
    expect(screen.getByText('Short summary')).toBeEnabled()
    expect(screen.getByText('Long summary')).toBeEnabled()
  })

  it('puts the spinner on the length actually running, and holds both', async () => {
    serveJobs([{ video_id: 'abc123', status: 'running', length: 'short' }])
    render(card())
    await act(async () => { await loadSummaries() })
    fireEvent.click(screen.getByLabelText('More actions'))
    expect(screen.getByText('Summarising…')).toBeDisabled()
    expect(screen.getByText('Long summary')).toBeDisabled()
    expect(screen.queryByText('Short summary')).not.toBeInTheDocument()
  })

  it('labels nothing for a video nobody has summarised', () => {
    render(card())
    expect(screen.queryByText('Summarised')).not.toBeInTheDocument()
    expect(screen.queryByText('Summarising')).not.toBeInTheDocument()
  })
})

function serveMemberships(map: Record<string, { id: number; name: string }[]>) {
  const fn = vi.fn(async () => ({
    ok: true, status: 200, json: async () => map,
    clone: () => ({ text: async () => '' }),
  }))
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

describe('VideoCard — playlist badge', () => {
  afterEach(() => { _resetPlaylistMemberships(); vi.restoreAllMocks() })

  it('names the playlist the video is saved in', async () => {
    serveMemberships({ abc123: [{ id: 1, name: 'Cooking' }] })
    render(card())
    await act(async () => { await loadPlaylistMemberships() })
    expect(screen.getByTestId('playlist-badge')).toHaveTextContent('Cooking')
  })

  it('names the first and counts the rest, all of them in its tooltip', async () => {
    serveMemberships({ abc123: [{ id: 1, name: 'Cooking' }, { id: 2, name: 'Later' }, { id: 3, name: 'Best' }] })
    render(card())
    await act(async () => { await loadPlaylistMemberships() })
    const badge = screen.getByTestId('playlist-badge')
    expect(badge).toHaveTextContent('Cooking+2')
    expect(badge).toHaveAttribute('title', 'Cooking\nLater\nBest')
  })

  it('has none for a video in no playlist', async () => {
    serveMemberships({ other: [{ id: 1, name: 'Cooking' }] })
    render(card())
    await act(async () => { await loadPlaylistMemberships() })
    expect(screen.queryByTestId('playlist-badge')).toBeNull()
  })

  it('leaves out the playlist whose page the card is on', async () => {
    serveMemberships({ abc123: [{ id: 1, name: 'Cooking' }, { id: 2, name: 'Later' }] })
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} playlistId={1} />)
    await act(async () => { await loadPlaylistMemberships() })
    expect(screen.getByTestId('playlist-badge')).toHaveTextContent('Later')
    expect(screen.getByTestId('playlist-badge')).not.toHaveTextContent('Cooking')
  })

  it('follows a change made anywhere in the app', async () => {
    serveMemberships({})
    render(card())
    await act(async () => { await loadPlaylistMemberships() })
    expect(screen.queryByTestId('playlist-badge')).toBeNull()
    serveMemberships({ abc123: [{ id: 1, name: 'Cooking' }] })
    await act(async () => {
      window.dispatchEvent(new Event('playlists-changed'))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByTestId('playlist-badge')).toHaveTextContent('Cooking')
  })
})

describe('VideoCard — labels and fields', () => {
  afterEach(() => { _resetCardNotes(); vi.restoreAllMocks() })

  it('badges the labels, and each field with its values, where Watched sits', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, clone: () => ({ text: async () => '' }),
      json: async () => ({ abc123: { labels: ['comedy', 'rewatch'], fields: [{ name: 'Cities', values: ['Tokyo', 'Kyoto'] }] } }),
    })) as unknown as typeof fetch
    render(<VideoCard video={mockVideo} isHovered={false} onHover={vi.fn()} onChannelClick={vi.fn()} watchProgress={{ position_seconds: 1234, watched: true }} />)
    await act(async () => { await loadCardNotes() })
    const labels = screen.getByTestId('labels-badge')
    expect(labels).toHaveTextContent('comedy, rewatch')
    expect(labels).toHaveAttribute('title', 'comedy\nrewatch')
    const field = screen.getByTestId('field-badge')
    expect(field).toHaveTextContent('CitiesTokyo, Kyoto')
    expect(field).toHaveAttribute('title', 'Cities: Tokyo, Kyoto')
    // One corner, one column: under Watched.
    expect(labels.parentElement).toBe(screen.getByText('Watched').parentElement)
  })

  it('has no badge for a video with none', () => {
    render(card())
    expect(screen.queryByTestId('labels-badge')).toBeNull()
    expect(screen.queryByTestId('field-badge')).toBeNull()
  })

  it('steps aside while the card is hovered, like the other badges', () => {
    render(<VideoCard video={mockVideo} isHovered={true} onHover={vi.fn()} onChannelClick={vi.fn()} />)
    act(() => { rememberNotes('abc123', { labels: ['comedy'], fields: [] }) })
    expect(screen.queryByTestId('labels-badge')).toBeNull()
  })

  it('follows what the Notes tab saves, and goes once it is emptied', () => {
    render(card())
    act(() => { rememberNotes('abc123', { labels: ['new'], fields: [{ name: 'Actors', values: [] }] }) })
    expect(screen.getByTestId('labels-badge')).toHaveTextContent('new')
    // A field still waiting for values has nothing to show.
    expect(screen.queryByTestId('field-badge')).toBeNull()
    act(() => { rememberNotes('abc123', { labels: [], fields: [{ name: 'Actors', values: [] }] }) })
    expect(screen.queryByTestId('labels-badge')).toBeNull()
  })
})
