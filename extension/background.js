/*
 * The two things a content script can't do: talk to the app's API, and remember
 * anything past a page load.
 *
 * A fetch from `open-in-app.js` carries `Origin: https://www.youtube.com`, and
 * the API allows the app's own origin only — so the browser blocks the reply.
 * Fetches from here don't go through CORS at all: the extension's own
 * `host_permissions` are the check instead.
 *
 * `APP_ORIGIN` is duplicated from `open-in-app.js` rather than shared, because
 * a service worker and a content script have no common scope short of adding a
 * module loader to a five-file, no-build extension. Change both, or nothing:
 * the button opens the wrong port while the save still works, which reads as a
 * baffling bug.
 */
const APP_ORIGIN = 'http://localhost:5173'

/* Long enough that a browse session costs one request, short enough that
 * saving something in the app shows up on YouTube while you're still there. */
const FRESH_MS = 60_000

const STORE_KEY = 'savedIds'

/*
 * What's on the Watch Later list, so hovering a card can say "already saved"
 * without a round trip.
 *
 * The list itself is the cache — not a private tally of what this extension
 * saved. That would be wrong twice over: blind to anything saved in the app,
 * and still claiming "saved" after you removed something there. The whole list
 * is one small GET, so there's nothing to gain by tracking a subset of it.
 *
 * Two layers, because an MV3 service worker is evicted after ~30s idle and
 * takes `memo` with it: `chrome.storage.local` survives that, and survives the
 * app being closed. It's a display hint either way — every save goes to the
 * API, which is the thing that actually decides.
 */
let memo = null // { ids: string[], at: number }

async function savedIds(force = false) {
  if (!force && memo && Date.now() - memo.at < FRESH_MS) return memo.ids
  try {
    const res = await fetch(`${APP_ORIGIN}/api/watch-later`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const ids = (await res.json()).map((v) => v.youtube_id)
    memo = { ids, at: Date.now() }
    await chrome.storage.local.set({ [STORE_KEY]: ids })
    return ids
  } catch {
    // The app isn't running. Last known list beats no list — and stamping it
    // like a fresh answer is deliberate, so a closed app costs one failed
    // request a minute rather than one per hover.
    const stored = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] || []
    memo = { ids: stored, at: Date.now() }
    return stored
  }
}

/** Record a save locally too, so the tick survives a scroll past the card. */
async function remember(videoId) {
  const ids = await savedIds()
  if (ids.includes(videoId)) return
  memo = { ids: [...ids, videoId], at: memo?.at ?? Date.now() }
  await chrome.storage.local.set({ [STORE_KEY]: memo.ids })
}

async function saveWatchLater(videoId) {
  const res = await fetch(`${APP_ORIGIN}/api/watch-later/by-id/${videoId}`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (data.saved) await remember(videoId)
  return data
}

/*
 * Which channels the app holds, so the pill on a YouTube channel page can say
 * "in YT Feed" without a round trip. Same two-layer cache as the Watch Later
 * list above, and the same reasoning: the list itself is the cache, because
 * anything else would be blind to what you did in the app.
 */
const CHANNELS_KEY = 'channelIds'
let channelMemo = null // { ids: string[], at: number }

async function channelIds(force = false) {
  if (!force && channelMemo && Date.now() - channelMemo.at < FRESH_MS) return channelMemo.ids
  try {
    const res = await fetch(`${APP_ORIGIN}/api/channels`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const ids = (await res.json()).map((c) => c.youtube_id)
    channelMemo = { ids, at: Date.now() }
    await chrome.storage.local.set({ [CHANNELS_KEY]: ids })
    return ids
  } catch {
    const stored = (await chrome.storage.local.get(CHANNELS_KEY))[CHANNELS_KEY] || []
    channelMemo = { ids: stored, at: Date.now() }
    return stored
  }
}

async function addChannel(url) {
  const res = await fetch(`${APP_ORIGIN}/api/channels/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The app resolves the URL itself — handle, id or vanity, it takes any of
    // them, which is why this hands over the page's address rather than trying
    // to work out which kind of channel reference it's looking at.
    body: JSON.stringify({ query: url }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const ids = await channelIds()
  if (!ids.includes(data.youtube_id)) {
    channelMemo = { ids: [...ids, data.youtube_id], at: channelMemo?.at ?? Date.now() }
    await chrome.storage.local.set({ [CHANNELS_KEY]: channelMemo.ids })
  }
  return data
}

/*
 * How far a video on youtube.com has got, handed to the app's own watch history.
 *
 * Nothing but the id and the play head goes over: the app resolves the title,
 * channel and thumbnail itself, by the same lookup its watch page uses. That's
 * the same bargain `saveWatchLater` strikes, and here there's a second reason —
 * YouTube's watch page gives a content script no dependable channel id (the one
 * place it exists is a Polymer property, which an isolated world can't read).
 *
 * Best-effort by design: the app being closed loses a progress ping, and the
 * next one ten seconds later carries a position that supersedes it anyway.
 */
async function reportProgress(videoId, position, duration) {
  const res = await fetch(`${APP_ORIGIN}/api/history/by-id/${videoId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position_seconds: position, duration_seconds: duration }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

const HANDLERS = {
  'save-watch-later': (msg) => saveWatchLater(msg.videoId),
  // `force` skips the TTL — the caller knows something the timer doesn't, e.g.
  // the tab was just switched back to from the app.
  'saved-ids': async (msg) => ({ ids: await savedIds(msg.force) }),
  'channel-ids': async (msg) => ({ ids: await channelIds(msg.force) }),
  'add-channel': (msg) => addChannel(msg.url),
  'report-progress': (msg) => reportProgress(msg.videoId, msg.position, msg.duration),
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type]
  if (!handler) return

  handler(msg)
    .then((data) => sendResponse({ ok: true, ...data }))
    // The app being closed is the everyday case, not an exception: report it
    // like any other failure and let the button say so.
    .catch((err) => sendResponse({ ok: false, error: String(err) }))

  // Keeps the message channel open for the async reply above.
  return true
})
