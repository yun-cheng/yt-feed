/**
 * A channel page confined to a search.
 *
 * The search box's "In this channel" doesn't open a results page — it hands
 * this one a `q`, and everything the page already does (its window, its sort,
 * its topic and watch filters, its paging) goes on applying. So what's worth
 * pinning is that the word reaches the server as one more parameter, that
 * changing it starts the list again rather than appending to it, and that
 * finding nothing says so in terms of BOTH the words and the window — the
 * window being as likely a reason for an empty search as the words are.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import ChannelPage from '../components/ChannelPage'
import { ALL_RANGE } from '../lib/timeWindow'

const CHANNEL = {
  youtube_id: 'chan1', title: 'Cooking', description: '', thumbnail_url: '',
  subscriber_count: 0, tags: [], suggested_tags: [], label_vocab: [], has_topics: false,
}

const video = (id: string, title: string) => ({
  youtube_id: id, title, channel_id: 'chan1', thumbnail_url: '',
  published_at: new Date().toISOString(), view_count: 1, like_count: 1,
  duration_seconds: 60, score: 1, title_labels: [],
})

/** Every /videos request this render made, newest last. */
let videoCalls: string[]
/** What the next /videos request answers with. */
let rows: ReturnType<typeof video>[]

function serve() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = async () => {
      if (url.includes('/videos?')) {
        videoCalls.push(url)
        return { channel: CHANNEL, window: '0-all', sort: 'likes', videos: rows, total: rows.length }
      }
      if (url.includes('/archive')) {
        return {
          held: rows.length, lifetime: rows.length, reachable: rows.length,
          capped_by_api: false, remaining: 0, oldest_held: null,
          exhausted: true, started: true, filling: false,
        }
      }
      if (url.includes('/api/tags')) return []
      return {}
    }
    return { ok: true, status: 200, json, clone: () => ({ text: async () => '' }) } as unknown as Response
  }))
}

/** The parameters of the most recent /videos request. */
const params = () => new URLSearchParams(videoCalls[videoCalls.length - 1].split('?')[1])

function show(q?: string) {
  return render(
    <ChannelPage channelId="chan1" age={ALL_RANGE} sort="likes" onSortChange={() => {}} q={q} />
  )
}

beforeEach(() => { videoCalls = []; rows = [video('v1', 'Pasta tonight')]; serve() })
afterEach(() => { vi.unstubAllGlobals() })

describe('ChannelPage — searching inside the channel', () => {
  it('asks for the whole channel when nothing is being searched', async () => {
    show()
    await waitFor(() => expect(videoCalls.length).toBeGreaterThan(0))
    expect(params().has('q')).toBe(false)
  })

  it('sends the words as one more parameter, beside the window and the sort', async () => {
    show('pasta')
    await waitFor(() => expect(videoCalls.length).toBeGreaterThan(0))
    expect(params().get('q')).toBe('pasta')
    expect(params().get('sort')).toBe('likes')
    expect(params().get('age')).toBe('0-all')
  })

  it('trims the query, and treats blank as no search at all', async () => {
    show('  pasta  ')
    await waitFor(() => expect(videoCalls.length).toBeGreaterThan(0))
    expect(params().get('q')).toBe('pasta')

    videoCalls = []
    show('   ')
    await waitFor(() => expect(videoCalls.length).toBeGreaterThan(0))
    expect(params().has('q')).toBe(false)
  })

  it('starts the list again when the words change, rather than appending', async () => {
    const { rerender } = show('pasta')
    await waitFor(() => expect(videoCalls.length).toBe(1))
    rerender(
      <ChannelPage channelId="chan1" age={ALL_RANGE} sort="likes" onSortChange={() => {}} q="soup" />
    )
    await waitFor(() => expect(videoCalls.length).toBe(2))
    expect(params().get('q')).toBe('soup')
    expect(params().get('offset')).toBe('0')
  })

  it('says what came back empty — the words AND the range it looked in', async () => {
    rows = []
    show('pasta')
    await screen.findByText(/Nothing matching/)
    expect(screen.getByText(/Nothing matching “pasta” in this time range\./)).toBeInTheDocument()
  })

  it('still says "no videos" when the page is empty for its own reasons', async () => {
    rows = []
    show()
    await screen.findByText('No videos in this time range.')
  })

  it('lists what matched, like any other page of this channel', async () => {
    rows = [video('v1', 'Pasta tonight'), video('v2', 'Pasta again')]
    show('pasta')
    expect(await screen.findByText('Pasta tonight')).toBeInTheDocument()
    expect(screen.getByText('Pasta again')).toBeInTheDocument()
  })
})
