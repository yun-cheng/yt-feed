/*
 * "Import to YT Feed" on a YouTube playlist page.
 *
 * The app can already pull playlists over the Data API, so why this? Because of
 * what that API won't hand over. `playlists.list?mine=true` returns playlists
 * the connected account CREATED — not Watch Later, not Liked Videos (YouTube
 * withdrew both in 2016), and not a playlist you follow but didn't make. It also
 * needs a Google connection, and on a household install exactly one person has
 * one.
 *
 * This reads the page as *you*. Whatever you can see on youtube.com, signed in
 * as whoever you are, is what gets imported — private playlists included — and
 * it costs no quota at all.
 *
 * Everything lives in an IIFE because content scripts in the same frame share
 * one lexical scope: a bare `const text` here would collide with
 * `open-in-app.js` and break both.
 */
;(() => {
  'use strict'

  /** The playlist this page is about, or null. */
  function playlistId() {
    if (location.pathname !== '/playlist') return null
    return new URLSearchParams(location.search).get('list')
  }

  /*
   * --- Reading the list -----------------------------------------------------
   *
   * Not from the DOM. A playlist page renders about a hundred rows and recycles
   * them as you scroll, so scraping what's on screen gets you a hundred videos
   * out of five hundred and no way to tell that it did.
   *
   * Instead: fetch the page fresh for its `ytInitialData` (the JSON the page
   * bootstrapped from — the first hundred items plus a continuation token), then
   * ask YouTube's own internal endpoint for the rest. A fetch from here is
   * same-origin and carries your cookies, so it sees exactly what you see.
   *
   * Every shape below was read off a live playlist page rather than guessed, and
   * every one of them has changed before: YouTube has already moved playlist
   * items from `playlistVideoRenderer` to `lockupViewModel` and the continuation
   * from `continuationItemRenderer` to `continuationItemViewModel`. So the
   * readers here are deliberately loose — they search for the shape rather than
   * walking a fixed path — and both the old and new spellings are accepted.
   */

  /** Pull `name = {...}` out of a page's inline scripts, brace-matched.
   *
   * Brace-matched rather than regexed: the JSON is two megabytes of deeply
   * nested objects containing braces inside string literals, so "up to the first
   * }" and "up to the last }" are both wrong. This tracks string and escape
   * state, which is the only way to find the real end.
   */
  function extractJson(html, name) {
    const at = html.indexOf(name)
    if (at < 0) return null
    const start = html.indexOf('{', at)
    if (start < 0) return null

    let depth = 0
    let inStr = false
    let escaped = false
    for (let i = start; i < html.length; i++) {
      const c = html[i]
      if (escaped) { escaped = false; continue }
      if (c === '\\') { escaped = true; continue }
      if (c === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
    return null
  }

  /** The first value under `key`, however deep. */
  function deep(node, key, d = 0) {
    if (!node || typeof node !== 'object' || d > 30) return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = deep(child, key, d + 1)
        if (found) return found
      }
      return null
    }
    if (node[key]) return node[key]
    for (const k of Object.keys(node)) {
      const found = deep(node[k], key, d + 1)
      if (found) return found
    }
    return null
  }

  const text = (n) => n?.simpleText ?? n?.runs?.map((r) => r.text).join('') ?? n?.content ?? ''

  /** "13:17" or "1:02:03" as seconds. */
  function seconds(label) {
    if (!label) return 0
    const parts = String(label).split(':').map((p) => parseInt(p, 10))
    if (!parts.length || parts.some(Number.isNaN)) return 0
    return parts.reduce((acc, p) => acc * 60 + p, 0)
  }

  /**
   * Who uploaded a video, from its lockup's metadata rows.
   *
   * The rows hold the channel, the view count and the age as interchangeable
   * "parts" whose ORDER is not stable — on a channel's uploads page part 0 is
   * the channel, on a continuation page it's "95K views". What is stable is that
   * only the channel links to a channel, so that's what this looks for.
   */
  function byline(meta) {
    const rows = meta.metadata?.contentMetadataViewModel?.metadataRows ?? []
    for (const row of rows) {
      for (const part of row.metadataParts ?? []) {
        const browse = deep(part, 'browseEndpoint')
        if (browse?.browseId?.startsWith('UC')) {
          return { id: browse.browseId, name: part.text?.content ?? '' }
        }
      }
    }
    // Fall back to the avatar, whose a11y label is "Go to channel <name>".
    const browse = deep(meta.image, 'browseEndpoint')
    const label = deep(meta.image, 'a11yLabel') ?? ''
    return {
      id: browse?.browseId ?? '',
      name: String(label).replace(/^Go to channel\s*/i, ''),
    }
  }

  /** A `lockupViewModel` — what a playlist row is today. */
  function fromLockup(l) {
    // A playlist can hold more than videos; a lockup is also how a nested
    // playlist or a channel card is drawn, and neither is importable.
    if (l.contentType && l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null
    const id = l.contentId
    if (!id) return null
    const meta = l.metadata?.lockupMetadataViewModel ?? {}
    const sources = l.contentImage?.thumbnailViewModel?.image?.sources ?? []
    const badge = deep(l.contentImage?.thumbnailViewModel?.overlays, 'thumbnailBadgeViewModel')
    const who = byline(meta)
    return {
      youtube_id: id,
      // Truncated to 100 characters by YouTube, with no full copy anywhere in
      // the payload. The app repairs it: its own stats lookup returns the real
      // title, and a longer one wins there.
      title: text(meta.title),
      channel_id: who.id,
      channel_name: who.name,
      thumbnail_url: sources.length ? sources[sources.length - 1].url : '',
      duration_seconds: seconds(badge?.text),
    }
  }

  /** A `playlistVideoRenderer` — the older shape, still worth accepting. */
  function fromRenderer(r) {
    const id = r.videoId
    if (!id) return null
    const owner = r.shortBylineText?.runs?.[0]
    const thumbs = r.thumbnail?.thumbnails ?? []
    return {
      youtube_id: id,
      title: text(r.title),
      channel_id: owner?.navigationEndpoint?.browseEndpoint?.browseId ?? '',
      channel_name: owner?.text ?? '',
      thumbnail_url: thumbs.length ? thumbs[thumbs.length - 1].url : '',
      duration_seconds: parseInt(r.lengthSeconds ?? '0', 10) || seconds(text(r.lengthText)),
    }
  }

  /** Every video in a blob, in document order, whichever shape it uses. */
  function readVideos(node, out = [], d = 0) {
    if (!node || typeof node !== 'object' || d > 40) return out
    if (Array.isArray(node)) {
      for (const child of node) readVideos(child, out, d + 1)
      return out
    }
    // Don't descend into a row we've just read: its own overlays contain
    // buttons pointing at other videos (a "save to Watch Later" endpoint names
    // the video it would save), and those aren't playlist entries.
    if (node.playlistVideoRenderer) {
      const v = fromRenderer(node.playlistVideoRenderer)
      if (v) out.push(v)
      return out
    }
    if (node.lockupViewModel) {
      const v = fromLockup(node.lockupViewModel)
      if (v) out.push(v)
      return out
    }
    for (const k of Object.keys(node)) readVideos(node[k], out, d + 1)
    return out
  }

  /** The "there's more" token, wherever this week's page keeps it. */
  function continuation(node, d = 0) {
    if (!node || typeof node !== 'object' || d > 40) return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = continuation(child, d + 1)
        if (found) return found
      }
      return null
    }
    // Matches both `continuationItemRenderer.continuationEndpoint` (old) and
    // `continuationItemViewModel.continuationCommand.innertubeCommand` (new) —
    // what they have in common is a `continuationCommand` holding a token.
    if (node.continuationCommand?.token) return node.continuationCommand.token
    for (const k of Object.keys(node)) {
      const found = continuation(node[k], d + 1)
      if (found) return found
    }
    return null
  }

  /** The client identity YouTube's internal API expects on a continuation. */
  function innertube(html) {
    const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1]
    const version = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1]
    if (!key) return null
    const context = extractJson(html, 'INNERTUBE_CONTEXT')
    if (context?.client) return { key, context }
    if (!version) return null
    return { key, context: { client: { clientName: 'WEB', clientVersion: version } } }
  }

  // 60 × 100 = 6,000 videos. A backstop against a continuation that never ends,
  // not a limit anyone should reach.
  const MAX_PAGES = 60

  /**
   * Every video in this playlist, in playlist order.
   *
   * Returns {name, videos, complete}. `complete` is false when the walk stopped
   * early — the button says so rather than presenting a partial import as a
   * whole one.
   */
  async function readPlaylist(id) {
    const res = await fetch(
      `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`,
      { credentials: 'include' }
    )
    if (!res.ok) throw new Error(`playlist page returned ${res.status}`)
    const html = await res.text()

    const data = extractJson(html, 'ytInitialData')
    if (!data) throw new Error('could not read the page')

    const name =
      text(data.header?.playlistHeaderRenderer?.title) ||
      data.metadata?.playlistMetadataRenderer?.title ||
      text(deep(data.header, 'pageHeaderViewModel')?.title) ||
      ''

    const videos = readVideos(data)
    let token = continuation(data)
    let complete = !token
    const tube = innertube(html)

    let pages = 0
    while (token && tube && pages < MAX_PAGES) {
      pages++
      const next = await fetch(
        `https://www.youtube.com/youtubei/v1/browse?key=${tube.key}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: tube.context, continuation: token }),
        }
      )
      if (!next.ok) break
      const blob = await next.json()
      const more = readVideos(blob)
      videos.push(...more)
      token = continuation(blob)
      if (!token) complete = true
      // A page that returns nothing but hands back another token would
      // otherwise spin to MAX_PAGES for no gain.
      if (!more.length) break
    }

    // A playlist may legitimately hold the same video twice; the app's copy
    // keys items by video id, so the second one has nowhere to go.
    const seen = new Set()
    const unique = videos.filter((v) => !seen.has(v.youtube_id) && seen.add(v.youtube_id))
    return { name, videos: unique, complete }
  }

  /*
   * --- The pill -------------------------------------------------------------
   */

  const host = document.createElement('div')
  host.style.cssText = 'display:inline-flex;align-items:center;align-self:center'
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `
    button {
      display: inline-flex; align-items: center; gap: 6px;
      height: 36px; padding: 0 15px; border: 0; border-radius: 18px;
      background: rgba(255,255,255,.1); color: #f1f1f1;
      font: 500 14px/1 Roboto, Arial, sans-serif; cursor: pointer;
      white-space: nowrap;
    }
    button:hover:not(:disabled) { background: rgba(255,255,255,.2) }
    button:disabled { cursor: default; opacity: .85 }
    button.failed { color: #ff8a80 }
    button.done { color: #8ab4f8 }
    svg { width: 18px; height: 18px; flex: none }
    :host(.floating) { position: fixed; right: 24px; bottom: 24px; z-index: 2147483000 }
    :host(.floating) button { background: #272727; box-shadow: 0 2px 12px rgba(0,0,0,.6) }
  `
  root.append(style)

  const pill = document.createElement('button')
  root.append(pill)

  function icon(d) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    el.setAttribute('viewBox', '0 0 24 24')
    el.setAttribute('fill', 'none')
    el.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '2')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    el.append(path)
    return el
  }

  const DOWNLOAD = 'M12 4v11m0 0-4-4m4 4 4-4M4 19h16'
  const TICK = 'M5 13l4 4L19 7'

  function draw(state, label, title) {
    pill.className = state === 'failed' ? 'failed' : state === 'done' ? 'done' : ''
    pill.disabled = state === 'busy'
    pill.replaceChildren(icon(state === 'done' ? TICK : DOWNLOAD))
    const span = document.createElement('span')
    span.textContent = label
    pill.append(span)
    pill.title = title || label
  }

  const reset = () => draw('idle', 'Import to YT Feed', 'Copy this playlist into YT Feed')

  /*
   * Where to put it. YouTube has renamed the playlist header's action row more
   * than once, so try the shapes it has used, newest first, and fall back to
   * floating the pill over the page — a button in a slightly odd place beats a
   * feature that silently isn't there after the next redesign.
   */
  const MOUNTS = [
    'ytd-playlist-header-renderer .play-menu',
    '.immersive-header-content .play-menu',
    '.play-menu',
    'yt-flexible-actions-view-model',
    'ytd-playlist-header-renderer #actions',
    '.metadata-action-bar',
  ]

  /* Width alone is the wrong test: the current action row is a flex container
   * that measures zero wide and forty tall. Either dimension means it's real. */
  function onScreen(el) {
    const r = el.getBoundingClientRect()
    return (r.width > 0 || r.height > 0) && getComputedStyle(el).display !== 'none'
  }

  function mount() {
    for (const sel of MOUNTS) {
      const row = [...document.querySelectorAll(sel)].filter(onScreen)[0]
      if (!row) continue
      if (host.parentElement !== row) {
        host.classList.remove('floating')
        row.append(host)
      }
      return true
    }
    return false
  }

  let listId = null
  let timer = null

  function sync(tries = 12) {
    clearTimeout(timer)
    const id = playlistId()
    if (!id) {
      host.remove()
      listId = null
      return
    }
    if (id !== listId) {
      listId = id
      reset()
    }
    const placed = mount()
    if (!placed && tries === 0) {
      // Out of retries and no header ever appeared — float it instead.
      host.classList.add('floating')
      document.documentElement.append(host)
    }
    if (tries > 0) timer = setTimeout(() => sync(tries - 1), 400)
  }

  /**
   * `chrome.runtime.sendMessage` REJECTS rather than resolving when the
   * messaging host is gone (an extension reload, a browser update). Same
   * wrapper as `open-in-app.js`, and here for the same reason.
   */
  async function ask(message) {
    try {
      return await chrome.runtime.sendMessage(message)
    } catch {
      return null
    }
  }

  pill.addEventListener('click', async () => {
    const id = listId
    if (!id || pill.disabled) return
    draw('busy', 'Reading…', 'Reading the playlist')

    let read
    try {
      read = await readPlaylist(id)
    } catch (e) {
      console.warn('[yt-feed] could not read playlist', e)
      return draw('failed', "Couldn't read it", String(e?.message || e))
    }
    // Navigated to another playlist mid-read; the answer isn't about this page.
    if (listId !== id) return
    if (!read.videos.length) {
      return draw('failed', 'Nothing to import', 'No videos found on this playlist')
    }

    draw('busy', `Sending ${read.videos.length}…`, 'Sending to YT Feed')
    const reply = await ask({
      type: 'import-playlist',
      youtube_id: id,
      name: read.name,
      videos: read.videos,
    })

    if (listId !== id) return
    if (!reply?.ok) {
      return draw('failed', "Couldn't import", reply?.error || 'Is the app running?')
    }
    const added = reply.added ?? 0
    draw(
      'done',
      added ? `Imported ${added}` : 'Already up to date',
      read.complete
        ? `${read.videos.length} videos read from this playlist`
        : `Read ${read.videos.length} videos — there may be more; click again to pick up the rest`
    )
  })

  // Fired by YouTube's own router on every in-page navigation.
  addEventListener('yt-navigate-finish', () => sync())
  sync()
})()
