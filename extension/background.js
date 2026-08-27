/*
 * The two things a content script can't do: talk to the app's API, and remember
 * anything past a page load.
 *
 * A fetch from `open-in-app.js` carries `Origin: https://www.youtube.com`, and
 * the API allows the app's own origin only — so the browser blocks the reply.
 * Fetches from here don't go through CORS at all: the extension's own
 * `host_permissions` are the check instead.
 *
 * This worker owns the configuration too — the app's address and the API key,
 * set on the options page. `open-in-app.js` asks for the address rather than
 * holding its own copy: a duplicated constant meant the button could open the
 * wrong port while saving still worked, which reads as a baffling bug.
 */
const CONFIG_KEY = 'config'
const DEFAULT_ORIGIN = 'http://localhost:5173'

/*
 * The API key says WHOSE app this is — whose history a video you watch on
 * youtube.com is recorded in, whose Watch Later the save button reaches.
 * Without one the app still answers if it holds exactly one account, which is
 * the ordinary case and keeps a single-person install working unconfigured.
 *
 * You shouldn't have to set either of these. `marker.js` runs on the app's own
 * pages, where a fetch is same-origin and carries the session cookie, and hands
 * both over the first time you open the app — see `app-identity` below. The
 * options page is the fallback for what that can't reach.
 */
let configMemo = null // { origin, apiKey }

async function config() {
  if (configMemo) return configMemo
  const stored = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || {}
  configMemo = {
    origin: stored.origin || DEFAULT_ORIGIN,
    apiKey: stored.apiKey || '',
  }
  return configMemo
}

// The options page writes the whole object at once, so one change event is one
// coherent config — and dropping the memo is enough to pick it up.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[CONFIG_KEY]) return
  configMemo = null
  // Everything cached below belongs to whoever the key named a moment ago.
  // Both layers have to go, not just the in-memory one: the stored copy is
  // what a fetch falls back to when the app is unreachable, so leaving it
  // would show the previous person's Watch Later ticks to the next.
  memo = channelMemo = playlistMemo = syncMemo = null
  chrome.storage.local.remove([STORE_KEY, CHANNELS_KEY, PLAYLISTS_KEY, SYNC_KEY])
})

/*
 * Adopt the identity the app's own page just handed us.
 *
 * Trusted because of where it comes from: `marker.js` only runs on origins in
 * this extension's `host_permissions`, and it only ever forwards what that
 * origin's own API returned to a session it already had. A page that isn't the
 * app has nothing to send, and a signed-out one has nothing to send either.
 *
 * The newest answer wins. If two people share a browser profile, the extension
 * belongs to whoever opened the app last — which is the same answer the app
 * itself would give that browser.
 */
async function adoptIdentity(origin, apiKey) {
  const current = await config()
  if (current.origin === origin && current.apiKey === apiKey) return false
  configMemo = { origin, apiKey }
  await chrome.storage.local.set({ [CONFIG_KEY]: configMemo })
  return true
}

/** `fetch` against the app, carrying whoever this browser is configured as. */
async function api(path, init = {}) {
  const { origin, apiKey } = await config()
  const headers = { ...(init.headers || {}) }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return fetch(`${origin}${path}`, { ...init, headers })
}

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
    const res = await api('/api/watch-later')
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
  const res = await api(`/api/watch-later/by-id/${videoId}`, { method: 'POST' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (data.saved) await remember(videoId)
  return data
}

/*
 * The playlists this account has, so the save-to menu is drawn the instant it
 * opens rather than after a round trip. Same two-layer cache as the Watch Later
 * list above, for the same two reasons: an MV3 worker is evicted after ~30s
 * idle, and a menu that can't draw until the app answers is a menu that flashes.
 *
 * Names and counts only. The cover thumbnails the app's own save-to menu shows
 * would be a dozen images per open, and this menu sits on someone else's page —
 * it has to be small enough to appear without a layout of its own.
 */
const PLAYLISTS_KEY = 'playlists'
let playlistMemo = null // { list: [{id, name, item_count}], at: number }

async function playlists(force = false) {
  if (!force && playlistMemo && Date.now() - playlistMemo.at < FRESH_MS) {
    return playlistMemo.list
  }
  try {
    const res = await api('/api/playlists')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list = (await res.json()).map((p) => ({
      id: p.id, name: p.name, item_count: p.item_count,
    }))
    playlistMemo = { list, at: Date.now() }
    await chrome.storage.local.set({ [PLAYLISTS_KEY]: list })
    return list
  } catch {
    const stored = (await chrome.storage.local.get(PLAYLISTS_KEY))[PLAYLISTS_KEY] || []
    playlistMemo = { list: stored, at: Date.now() }
    return stored
  }
}

/*
 * Which of them already hold this video.
 *
 * Uncached, unlike everything else here, and both halves of that are deliberate.
 * It's per-video, so there is no one list to keep — and it's asked on a CLICK
 * rather than on a hover, which affords a round trip. Membership is also the
 * one answer that must not be stale: it is what the ticks say, and you may have
 * changed it in the app since.
 */
async function playlistsContaining(videoId) {
  const res = await api(`/api/playlists/containing/${videoId}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

/** Keep the cached count honest between opens, the way `remember` does. */
function nudgeCount(playlistId, delta) {
  if (!playlistMemo) return
  playlistMemo.list = playlistMemo.list.map((p) => (
    p.id === playlistId ? { ...p, item_count: Math.max(0, p.item_count + delta) } : p
  ))
  chrome.storage.local.set({ [PLAYLISTS_KEY]: playlistMemo.list })
}

/*
 * Add by id alone — the same bargain `saveWatchLater` strikes, and for the same
 * reason: the app resolves the title, channel and thumbnail on its side rather
 * than have a content script scrape them out of markup that changes.
 *
 * `saved: false` is a video the app couldn't resolve (private, deleted,
 * region-blocked). That's a failure to whoever clicked, whatever the status
 * code was, which is why the caller checks it rather than just `ok`.
 */
async function addToPlaylist(playlistId, videoId) {
  const res = await api(`/api/playlists/${playlistId}/items/by-id/${videoId}`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (data.saved && !data.already) nudgeCount(playlistId, 1)
  return data
}

/*
 * A new playlist, made from the menu.
 *
 * It lands in the cached list immediately rather than waiting for the next
 * refresh: the caller's very next move is to put a video in it, and a menu that
 * forgets the playlist you just made a second later reads as a failed save.
 */
async function createPlaylist(name) {
  const res = await api('/api/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (playlistMemo) {
    // Newest first, which is the order `GET /api/playlists` serves.
    playlistMemo.list = [
      { id: data.id, name: data.name, item_count: 0 }, ...playlistMemo.list,
    ]
    chrome.storage.local.set({ [PLAYLISTS_KEY]: playlistMemo.list })
  }
  return data
}

async function removeFromPlaylist(playlistId, videoId) {
  const res = await api(`/api/playlists/${playlistId}/items/${videoId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  nudgeCount(playlistId, -1)
  return { removed: true }
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
    const res = await api('/api/channels')
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
  const res = await api('/api/channels/add', {
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
 * Whether the app wants to hear about what you watch on youtube.com.
 *
 * The switch is on the app's own Settings page rather than in an options page
 * here, because what it governs is what gets written to the app's database —
 * and the app is where you'd go to look for it. This is the copy the sampler
 * reads, cached like the two lists above so the decision costs nothing per tick.
 *
 * An unreachable app answers `true`: a report sent while it's down fails
 * harmlessly, whereas defaulting to `false` would quietly disable the feature
 * for a minute every time the app restarted.
 */
const SYNC_KEY = 'historySync'
let syncMemo = null // { on: boolean, at: number }

async function historySync(force = false) {
  if (!force && syncMemo && Date.now() - syncMemo.at < FRESH_MS) return syncMemo.on
  try {
    const res = await api('/api/settings')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const on = (await res.json()).values?.youtube_history_sync !== false
    syncMemo = { on, at: Date.now() }
    await chrome.storage.local.set({ [SYNC_KEY]: on })
    return on
  } catch {
    const stored = (await chrome.storage.local.get(SYNC_KEY))[SYNC_KEY]
    const on = stored !== false
    syncMemo = { on, at: Date.now() }
    return on
  }
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
  const res = await api(`/api/history/by-id/${videoId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position_seconds: position, duration_seconds: duration }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

/*
 * A playlist `playlist-import.js` read off youtube.com, handed to the app.
 *
 * The whole list travels in the body, which is what makes this work at all: the
 * app needs no YouTube token to receive it, so it reaches Watch Later, private
 * playlists and playlists you follow but didn't make — none of which the Data
 * API will serve — and it works for a household member with no Google account
 * connected at all.
 *
 * Whose playlist it becomes is decided by the API key this request carries, the
 * same as everything else here.
 */
async function importPlaylist({ youtube_id, name, videos }) {
  const res = await api('/api/playlists/import-external', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ youtube_id, name, videos }),
  })
  if (!res.ok) {
    // The app's own message is more use than the status code — it's the one
    // that says "sign in first" or "nothing to import".
    const detail = await res.json().then((b) => b.detail).catch(() => null)
    throw new Error(detail || `HTTP ${res.status}`)
  }
  return await res.json()
}

const HANDLERS = {
  'save-watch-later': (msg) => saveWatchLater(msg.videoId),
  'import-playlist': (msg) => importPlaylist(msg),
  // `force` skips the TTL — the caller knows something the timer doesn't, e.g.
  // the tab was just switched back to from the app.
  'saved-ids': async (msg) => ({ ids: await savedIds(msg.force) }),
  'playlists': async (msg) => ({ playlists: await playlists(msg.force) }),
  'playlists-containing': async (msg) => ({ ids: await playlistsContaining(msg.videoId) }),
  'playlist-create': (msg) => createPlaylist(msg.name),
  'playlist-add': (msg) => addToPlaylist(msg.playlistId, msg.videoId),
  'playlist-remove': (msg) => removeFromPlaylist(msg.playlistId, msg.videoId),
  'channel-ids': async (msg) => ({ ids: await channelIds(msg.force) }),
  'add-channel': (msg) => addChannel(msg.url),
  'history-sync': async (msg) => ({ enabled: await historySync(msg.force) }),
  // The content script's only way to know where the app lives — see the note
  // at the top about why it doesn't keep its own copy.
  'app-origin': async () => ({ origin: (await config()).origin }),
  // Sent by marker.js from the app's own page. `changed` is for the log more
  // than the caller — the storage listener below does the cache clearing.
  'app-identity': async (msg) => ({
    changed: await adoptIdentity(msg.origin, msg.apiKey),
  }),
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
