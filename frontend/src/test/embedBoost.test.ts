/**
 * The extension's side of the embed boost (`extension/embed-boost.js`).
 *
 * It runs in the YouTube frame, which is the only place the player's <video> is
 * reachable, and takes a level from the app over postMessage. Tested here rather
 * than in the extension because this is where a test runner already lives — and
 * because the interesting parts are the protocol and the refusals, both of which
 * are plain DOM.
 *
 * The script keeps ONE graph per frame, so these run as a sequence: what it
 * refuses, then the failure that leaves the player alone, then the build.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const APP = 'http://localhost:5173'

const parent = { postMessage: vi.fn() }
let ctxState: 'running' | 'suspended' = 'running'
let gain: { gain: { value: number } }
let connected: unknown[] = []
let built = 0

function stubAudio() {
  connected = []
  gain = { gain: { value: 1 } }
  // Every node connects to the next and returns it, so one chainable stub covers
  // source → gain → limiter → destination however long that chain gets.
  const node = { connect: () => node }
  const param = () => ({ value: 0 })
  const ctx = {
    get state() { return ctxState },
    createGain: () => gain,
    createDynamicsCompressor: () => ({
      ...node, threshold: param(), knee: param(), ratio: param(),
      attack: param(), release: param(),
    }),
    createMediaElementSource: (el: unknown) => {
      connected.push(el)
      return node
    },
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
    destination: {},
  }
  // An arrow function can't be `new`ed, and that's how it's used.
  vi.stubGlobal('AudioContext', function () { built++; return ctx })
}

/** A message as the app sends it: from the parent frame, from the app's origin. */
function send(data: unknown, origin = APP, source: unknown = parent) {
  const e = new MessageEvent('message', { data, origin })
  Object.defineProperty(e, 'source', { value: source })
  window.dispatchEvent(e)
  return new Promise((r) => setTimeout(r, 0))  // the handler awaits the context
}

const replies = () => parent.postMessage.mock.calls.map((c) => c[0])

beforeAll(async () => {
  Object.defineProperty(window, 'parent', { value: parent, configurable: true })
  document.body.appendChild(document.createElement('video'))
  stubAudio()
  // Plain JS from the extension, outside the app's own sources: there's no
  // declaration for it and there shouldn't be — it isn't a module the app links.
  // @ts-expect-error -- untyped side-effect import
  await import('../../../extension/embed-boost.js')
})

// `built` counts constructions since the last case, not since the file began.
beforeEach(() => { parent.postMessage.mockClear(); built = 0 })

describe('embed-boost — what it answers', () => {
  it('says it is here when the app pings', async () => {
    await send({ __ytFeed: 'boost', op: 'ping' })
    expect(replies()).toEqual([{ __ytFeed: 'boost', op: 'ready' }])
  })

  it('replies to the app’s origin, so the reply goes nowhere else', async () => {
    await send({ __ytFeed: 'boost', op: 'ping' })
    expect(parent.postMessage.mock.calls[0][1]).toBe(APP)
  })

  it('ignores a page that is not the app', async () => {
    await send({ __ytFeed: 'boost', op: 'ping' }, 'https://evil.example')
    await send({ __ytFeed: 'boost', op: 'set', value: 4 }, 'https://evil.example')
    expect(replies()).toEqual([])
  })

  it('ignores anything that is not the parent frame', async () => {
    await send({ __ytFeed: 'boost', op: 'ping' }, APP, { postMessage: vi.fn() })
    expect(replies()).toEqual([])
  })

  it('ignores messages that are not ours', async () => {
    await send({ op: 'ping' })
    await send('ping')
    await send(null)
    expect(replies()).toEqual([])
  })
})

describe('embed-boost — the gain', () => {
  it('takes no audio to leave it alone at 1×', async () => {
    await send({ __ytFeed: 'boost', op: 'set', value: 1 })
    expect(built).toBe(0)
    expect(replies()).toEqual([{ __ytFeed: 'boost', op: 'result', ok: true, value: 1 }])
  })

  it('leaves the player untouched when the context will not start', async () => {
    // The click that asked for this happened in the app's frame, not ours, so
    // the autoplay policy can refuse. Routing anyway would be silence.
    ctxState = 'suspended'
    await send({ __ytFeed: 'boost', op: 'set', value: 2 })
    expect(connected).toEqual([])
    expect(replies()).toEqual([{ __ytFeed: 'boost', op: 'result', ok: false, value: 1 }])
    ctxState = 'running'
  })

  it('routes the player through a gain node and says what it did', async () => {
    await send({ __ytFeed: 'boost', op: 'set', value: 2 })
    expect(built).toBe(1)
    expect(connected).toEqual([document.querySelector('video')])
    expect(gain.gain.value).toBe(2)
    expect(replies()).toEqual([{ __ytFeed: 'boost', op: 'result', ok: true, value: 2 }])
  })

  it('builds once and reuses it', async () => {
    await send({ __ytFeed: 'boost', op: 'set', value: 3 })
    expect(built).toBe(0)  // nothing new; the graph from the last case still stands
    expect(gain.gain.value).toBe(3)
  })

  it('clamps to the range the app offers', async () => {
    await send({ __ytFeed: 'boost', op: 'set', value: 99 })
    expect(gain.gain.value).toBe(8)
    await send({ __ytFeed: 'boost', op: 'set', value: -5 })
    expect(gain.gain.value).toBe(1)
  })

  it('treats a value it cannot read as normal', async () => {
    await send({ __ytFeed: 'boost', op: 'set', value: 'loud' })
    expect(gain.gain.value).toBe(1)
  })
})
