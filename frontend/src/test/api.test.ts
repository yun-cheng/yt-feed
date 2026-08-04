/**
 * apiFetch is the app's single guard against a request failing silently — most
 * call sites do `if (!res.ok) return` or `.catch(() => {})`, so if the toast
 * doesn't fire here, nothing tells the user anything went wrong.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiFetch } from '../lib/api'
import * as toastStore from '../hooks/toastStore'

type FakeResponse = Partial<Omit<Response, 'body'>> & { payload?: string }

function response({ payload = '', ...over }: FakeResponse = {}) {
  return {
    ok: true,
    status: 200,
    clone: () => ({ text: async () => payload }),
    json: async () => JSON.parse(payload || '{}'),
    text: async () => payload,
    ...over,
  } as unknown as Response
}

let pushToast: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  pushToast = vi.spyOn(toastStore, 'pushToast').mockReturnValue(1)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// The toast is pushed from a floating promise (the body is read off a clone so
// the caller's own res.json() still works), so let the microtask queue drain.
const settled = () => new Promise((r) => setTimeout(r, 0))

describe('apiFetch — the happy path', () => {
  it('passes the response straight through', async () => {
    const res = response({ payload: '{"ok":1}' })
    vi.mocked(fetch).mockResolvedValue(res)
    expect(await apiFetch('/api/thing')).toBe(res)
    await settled()
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('forwards init to fetch without the quiet flag', async () => {
    // `quiet` is ours; passing it on would put an unknown key in RequestInit.
    vi.mocked(fetch).mockResolvedValue(response())
    await apiFetch('/api/thing', { method: 'POST', body: '{}', quiet: true })
    expect(fetch).toHaveBeenCalledWith('/api/thing', { method: 'POST', body: '{}' })
  })
})

describe('apiFetch — a failed response', () => {
  it('toasts with the method, path and status', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ok: false, status: 500 }))
    await apiFetch('/api/thing', { method: 'post' })
    await settled()
    expect(pushToast).toHaveBeenCalledWith('POST /api/thing failed (500)')
  })

  it('defaults the method to GET', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ok: false, status: 404 }))
    await apiFetch('/api/thing')
    await settled()
    expect(pushToast).toHaveBeenCalledWith('GET /api/thing failed (404)')
  })

  it("includes FastAPI's detail message when there is one", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response({ ok: false, status: 404, payload: '{"detail":"No such bookmark"}' })
    )
    await apiFetch('/api/bookmarks/id/9')
    await settled()
    expect(pushToast).toHaveBeenCalledWith('GET /api/bookmarks/id/9 failed (404): No such bookmark')
  })

  it('falls back to raw text when the body is not JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ok: false, status: 502, payload: 'Bad Gateway' }))
    await apiFetch('/api/thing')
    await settled()
    expect(pushToast).toHaveBeenCalledWith('GET /api/thing failed (502): Bad Gateway')
  })

  it('truncates a long body so the toast stays readable', async () => {
    vi.mocked(fetch).mockResolvedValue(
      response({ ok: false, status: 500, payload: 'x'.repeat(500) })
    )
    await apiFetch('/api/thing')
    await settled()
    const msg = vi.mocked(pushToast).mock.calls[0][0] as string
    expect(msg.length).toBeLessThan(200)
    expect(msg.endsWith('…')).toBe(true)
  })

  it('still resolves to the response so the caller can handle it', async () => {
    const res = response({ ok: false, status: 500 })
    vi.mocked(fetch).mockResolvedValue(res)
    expect(await apiFetch('/api/thing')).toBe(res)
  })

  it('leaves the body unread for the caller', async () => {
    // The detail is read off a CLONE; reading the original would leave the
    // caller's res.json() with a consumed stream.
    const json = vi.fn().mockResolvedValue({ detail: 'nope' })
    vi.mocked(fetch).mockResolvedValue(response({ ok: false, status: 400, payload: '{"detail":"nope"}', json }))
    const res = await apiFetch('/api/thing')
    await settled()
    await expect(res.json()).resolves.toEqual({ detail: 'nope' })
  })
})

describe('apiFetch — a network error', () => {
  it('toasts and rethrows, so the caller still sees the failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(apiFetch('/api/thing', { method: 'DELETE' })).rejects.toThrow('Failed to fetch')
    expect(pushToast).toHaveBeenCalledWith('DELETE /api/thing — network error')
  })
})

describe('apiFetch — quiet mode', () => {
  it('stays silent on a failed response', async () => {
    // For hover-preview captions and the topic poll, where a toast per failure
    // is noise and the feature already degrades gracefully.
    vi.mocked(fetch).mockResolvedValue(response({ ok: false, status: 500 }))
    await apiFetch('/api/feed/captions/x', { quiet: true })
    await settled()
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('stays silent on a network error, but still rethrows', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(apiFetch('/api/thing', { quiet: true })).rejects.toThrow()
    expect(pushToast).not.toHaveBeenCalled()
  })
})

describe('apiFetch — input shapes', () => {
  it('reads the path out of a URL', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ok: false, status: 500 }))
    await apiFetch(new URL('http://localhost:8000/api/thing?x=1'))
    await settled()
    expect(pushToast).toHaveBeenCalledWith('GET /api/thing failed (500)')
  })

  it('reads the method and url out of a Request', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ok: false, status: 500 }))
    await apiFetch({ url: '/api/thing', method: 'put' } as Request)
    await settled()
    expect(pushToast).toHaveBeenCalledWith('PUT /api/thing failed (500)')
  })

  it('an explicit init method wins over the Request', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ok: false, status: 500 }))
    await apiFetch({ url: '/api/thing', method: 'get' } as Request, { method: 'DELETE' })
    await settled()
    expect(pushToast).toHaveBeenCalledWith('DELETE /api/thing failed (500)')
  })
})
