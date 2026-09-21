/**
 * Adding a channel by hand — the two calls behind all three ways in (the add
 * dialog, the page you land on for a channel this app doesn't hold, and the
 * extension's pill on YouTube itself).
 *
 * Small enough that what's worth pinning is the parts a rewrite would drop:
 * that a lookup miss is answered rather than toasted, and that a null means
 * "no" rather than "here is a broken object".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { addChannel, lookupChannel } from '../lib/channels'
import * as toastStore from '../hooks/toastStore'

function response(over: Partial<Response> & { payload?: unknown } = {}) {
  const { payload, ...rest } = over
  return {
    ok: true,
    status: 200,
    clone: () => ({ text: async () => JSON.stringify(payload ?? {}) }),
    json: async () => payload,
    text: async () => JSON.stringify(payload ?? {}),
    ...rest,
  } as unknown as Response
}

let pushToast: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => response()))
  pushToast = vi.spyOn(toastStore, 'pushToast').mockReturnValue(1)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** apiFetch pushes its toast from a floating promise; let it drain. */
const settled = () => new Promise((r) => setTimeout(r, 0))

describe('lookupChannel', () => {
  it('asks about the query and hands back what it was told', async () => {
    const found = { youtube_id: 'UC123', title: 'A Channel', known: false }
    vi.mocked(fetch).mockResolvedValueOnce(response({ payload: found }))

    expect(await lookupChannel('UC123')).toEqual(found)
  })

  it('encodes the query rather than pasting it into the URL', async () => {
    // Handles start with `@`, and a pasted URL brings `?`, `&` and `/` with it —
    // any of which would otherwise end the param or start another one.
    await lookupChannel('https://youtube.com/@some one?x=1&y=2')

    expect(fetch).toHaveBeenCalledWith(
      '/api/channels/lookup?q=https%3A%2F%2Fyoutube.com%2F%40some%20one%3Fx%3D1%26y%3D2',
      {},
    )
  })

  it('answers "not a channel" without shouting about it', async () => {
    // A miss is this call's ordinary negative answer — the dialog says so in
    // place, where you are already looking. A toast would be the app telling
    // you something went wrong when nothing did.
    vi.mocked(fetch).mockResolvedValueOnce(response({ ok: false, status: 404 }))

    expect(await lookupChannel('not-a-channel')).toBeNull()
    await settled()
    expect(pushToast).not.toHaveBeenCalled()
  })
})

describe('addChannel', () => {
  it('posts the query and returns the added channel', async () => {
    const added = { youtube_id: 'UC123', title: 'A Channel', already: false, added_videos: 30 }
    vi.mocked(fetch).mockResolvedValueOnce(response({ payload: added }))

    expect(await addChannel('UC123')).toEqual(added)
    expect(fetch).toHaveBeenCalledWith('/api/channels/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'UC123' }),
    })
  })

  it('is null on a refusal, so a caller cannot read fields off a failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ok: false, status: 400 }))

    expect(await addChannel('nope')).toBeNull()
  })

  it('lets a failed add surface, unlike a lookup miss', async () => {
    // Adding is something you asked for, so it failing is news — this one is
    // NOT quiet, and the difference between the two calls is the point.
    vi.mocked(fetch).mockResolvedValueOnce(response({ ok: false, status: 500 }))

    await addChannel('UC123')
    await settled()
    expect(pushToast).toHaveBeenCalled()
  })
})
