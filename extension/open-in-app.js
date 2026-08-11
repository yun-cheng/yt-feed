/*
 * Two buttons on the corner of a YouTube video card: open in YT Feed, and save
 * to the app's Watch Later.
 *
 * Hover any thumbnail on youtube.com and they appear, stacked, in its top-left
 * corner. The first opens that video in the app instead of on YouTube; the
 * second saves it without leaving the page you're on.
 *
 * There is exactly ONE pair, parked off-screen and moved onto whatever the
 * pointer is over. The obvious alternative — inject buttons into every card —
 * needs a MutationObserver, has to name the card elements it's injecting into,
 * and then fights YouTube's virtualised lists, which RECYCLE those nodes as you
 * scroll (so the buttons follow the wrong video). Moving one element sidesteps
 * all three, and costs one listener instead of a live DOM subscription.
 *
 * The only YouTube fact it relies on is the URL shape of a video link, which is
 * the most stable thing on the site — /watch?v= and /shorts/ have outlived every
 * generation of its markup. Contrast embed.css, which is pinned to an element ID
 * and will break the next time YouTube reshuffles the player (see README).
 *
 * Styles live in a shadow root so nothing here can leak onto YouTube's page and
 * nothing on YouTube's page can restyle the button.
 */

/*
 * Where the app is served, set on the extension's options page.
 *
 * Held here as a plain variable and asked of the worker at startup, rather than
 * read from storage directly: the worker already owns the configuration (it
 * needs the API key that travels with it), and one owner means the address the
 * button opens can't disagree with the address the save posts to. Until the
 * answer arrives — a few milliseconds, and the worker may need waking — it's the
 * default, which is what an unconfigured install uses anyway.
 */
let appOrigin = 'http://localhost:5173'

async function refreshOrigin() {
  const reply = await ask({ type: 'app-origin' })
  if (reply?.ok && reply.origin) appOrigin = reply.origin
}

/* Named so repeat clicks REUSE one app tab rather than piling up tabs. */
const APP_TAB = 'ytfeed'

/* Below this, a link is a chip or a text mention rather than a video card. */
const MIN_THUMB_WIDTH = 80

/* Inset from the thumbnail's corner, matching YouTube's own overlay buttons. */
const INSET = 8

/* Below this many seconds in, there's no position worth handing to the app. */
const HANDOFF_MIN_SEC = 5

/** The YouTube video id in a link, or null if it isn't a link to a video. */
function videoId(href) {
  let url
  try {
    url = new URL(href, location.origin)
  } catch {
    return null
  }
  if (url.pathname === '/watch') return url.searchParams.get('v')
  const short = url.pathname.match(/^\/shorts\/([\w-]{5,})/)
  return short ? short[1] : null
}

/**
 * The thumbnail link of the card the given link belongs to.
 *
 * A card has several links to the same video — thumbnail, title, sometimes the
 * duration badge — and the button belongs on the thumbnail whichever one the
 * pointer found. So: climb a few ancestors and take the WIDEST link to the same
 * video. Which element that is doesn't matter, and isn't named here; that's what
 * keeps this from going stale.
 *
 * Widest rather than first-with-an-image because search results expand a card
 * into a chapter list, and every chapter is another link to the same video with
 * its own little image. Those are laid out at zero width until the card opens,
 * and none of them can ever out-measure the thumbnail they belong to.
 */
function thumbnailLink(link, id) {
  let best = link
  let bestWidth = link.getBoundingClientRect().width
  let node = link
  for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
    for (const other of node.querySelectorAll('a[href]')) {
      if (videoId(other.href) !== id) continue
      const width = other.getBoundingClientRect().width
      if (width > bestWidth) {
        best = other
        bestWidth = width
      }
    }
  }
  return best
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** An SVG element with attributes — `createElement` alone makes an HTML one. */
function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value)
  return el
}

const host = document.createElement('div')
host.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;display:none'
// Not `display: flex` on the host itself: `place()` toggles that property, and
// it would have to remember which value means visible. The shadow root gets one
// wrapper instead, and the host stays a plain block.
const root = host.attachShadow({ mode: 'open' })

// Built element by element rather than with innerHTML, because youtube.com sets
// `require-trusted-types-for 'script'` and an innerHTML assignment throws there.
// Chrome does normally exempt a content script's isolated world from the page's
// CSP — but that exemption has broken before, and this owes it nothing.
const style = document.createElement('style')
// The mute and captions buttons YouTube floats over a thumbnail's hover
// preview: a plain dark circle with a white icon and no text. Every number here
// is copied from the rule that draws them rather than eyeballed —
// `.ytInlinePlayerControlsTopRightControlsCircleButton`, which is 40x40 at
// rgba(0,0,0,.6) with a 24px icon, inset 8px from the corner.
//
// The one deliberate difference is the hover state. YouTube's pair has none —
// they're a permanent fixture on a playing video — but these appear on hover and
// are the only clickable things on the thumbnail, so they answer the pointer.
style.textContent = `
  .stack {
    display: flex;
    flex-direction: column;
    /* YouTube's own inset, reused as the gap so the pair reads as one column. */
    gap: 8px;
  }
  button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    cursor: pointer;
    /* Not inherited through a shadow boundary, so it has to be said here. */
    font: inherit;
    transition: background 0.1s;
  }
  button:hover { background: rgba(0, 0, 0, 0.9); }
  button:disabled { cursor: default; }
  svg { width: 24px; height: 24px; display: block; }
  /* Saved is said by the icon alone — a tick on the same dark circle as
     everything else. Only the failure gets a colour, because it's the one state
     you have to notice rather than merely read, and it clears on the next card. */
  button.failed { background: rgba(153, 27, 27, 0.9); }
`

/** An icon-only button, like the ones it's modelled on: the tooltip names it. */
function makeButton(label, icon) {
  const el = document.createElement('button')
  el.type = 'button'
  el.title = label
  el.setAttribute('aria-label', label)
  el.append(icon)
  return el
}

/*
 * The icons are FUNCTIONS rather than elements because a watch page carries two
 * copies of this pair — the hover one and the one in YouTube's action row — and
 * appending a node MOVES it rather than copying it. A shared instance would
 * teleport out of one button and into the other.
 */
function openIcon() {
  const el = svg('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' })
  el.append(
    svg('rect', {
      x: 3, y: 4, width: 18, height: 16, rx: 3,
      stroke: 'currentColor', 'stroke-width': 2,
    }),
    svg('path', { d: 'M10 9.5v5l4-2.5z', fill: 'currentColor' }),
  )
  return el
}

// A clock, which is what YouTube's own Watch Later is drawn as — the app's list
// is a different list, but the gesture is the one people already know.
function clockIcon() {
  const el = svg('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' })
  el.append(
    svg('circle', {
      cx: 12, cy: 12, r: 9, stroke: 'currentColor', 'stroke-width': 2,
    }),
    svg('path', {
      d: 'M12 7v5.5l3.5 2', stroke: 'currentColor', 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }),
  )
  return el
}

// Saved. The icon is the whole difference — same circle, same fill — so a
// column of thumbnails reads as one set of controls rather than a scoreboard.
function tickIcon() {
  const el = svg('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' })
  el.append(svg('path', {
    d: 'M5 12.5l4.5 4.5L19 7.5', stroke: 'currentColor', 'stroke-width': 2.5,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }))
  return el
}

const openButton = makeButton('Open in YT Feed', openIcon())
const saveButton = makeButton('Save to YT Feed Watch Later', clockIcon())

const stack = document.createElement('div')
stack.className = 'stack'
stack.append(openButton, saveButton)
root.append(style, stack)

/** The link the pair is currently parked on, so scrolling can follow it. */
let anchored = null
let currentId = null

/*
 * What's already on the Watch Later list.
 *
 * A copy of the service worker's copy, kept here because hovering has to paint
 * NOW — an awaited answer arrives after you've looked. The worker owns
 * freshness (it re-reads the list from the app on a timer); this just asks
 * again, in the background, whenever a hover finds it might be stale.
 */
const saved = new Set()
let askedAt = 0
const ASK_EVERY_MS = 60_000

/**
 * Ask the service worker something, and treat "couldn't ask" as an answer.
 *
 * `chrome.runtime.sendMessage` REJECTS rather than resolving when the messaging
 * itself fails, and two of those failures are ordinary here rather than
 * exceptional: the worker is asleep and doesn't answer in time, and — the
 * common one during development — the extension has been reloaded, which leaves
 * the copy of this script already running in an open tab holding a dead handle
 * ("Extension context invalidated"). Every caller below already treats a
 * missing `ok` as "the app didn't answer", so the rejection has nowhere useful
 * to go: unawaited, it surfaces as an uncaught error on the line that awaited
 * it, which is a console full of noise about a tab that simply needs reloading.
 */
async function ask(message) {
  try {
    return await chrome.runtime.sendMessage(message)
  } catch {
    return null
  }
}

async function refreshSaved(force = false) {
  askedAt = Date.now()
  const reply = await ask({ type: 'saved-ids', force })
  if (!reply?.ok) return
  saved.clear()
  for (const id of reply.ids) saved.add(id)
  // The video under the pointer may be one of them, and it isn't going to be
  // hovered again just because we finally know. Same for the one the watch page
  // is about, which isn't going anywhere at all.
  if (currentId && !saveButton.classList.contains('failed')) hoverSave.reset(currentId)
  if (barId && !savePill.classList.contains('failed')) barSave.reset(barId)
}

function place() {
  if (!anchored || !anchored.isConnected) return hide()
  const box = anchored.getBoundingClientRect()
  // Scrolled out of the viewport: let go entirely, which also stops the scroll
  // handler doing any more work. The next mouseover brings it back.
  if (box.bottom < 0 || box.top > innerHeight) return hide()
  host.style.transform = `translate(${box.left + INSET}px, ${box.top + INSET}px)`
  host.style.display = 'block'
}

function hide() {
  host.style.display = 'none'
  anchored = null
  currentId = null
}

/**
 * A save button and the two operations every copy of one needs.
 *
 * `label`, when given, turns the icon-only circle into a labelled pill: it's
 * called with the state and its answer sits beside the icon.
 */
function saveControl(el, label) {
  /** Draw the button in one of its three states. */
  function draw(state, title) {
    el.disabled = false
    el.classList.toggle('failed', state === 'failed')
    el.replaceChildren(state === 'saved' ? tickIcon() : clockIcon())
    if (label) {
      const span = document.createElement('span')
      span.className = 'label'
      span.textContent = label(state)
      el.append(span)
    }
    el.title = title
  }

  return {
    el,
    draw,
    /**
     * The button as it should look for a video we haven't just clicked it for.
     *
     * Which is a tick if the video is already on the list — that's the whole
     * point of the cache, and it has to be readable the instant the pointer
     * lands, so it reads a Set held here rather than awaiting the worker.
     */
    reset(id) {
      if (saved.has(id)) draw('saved', 'Already in Watch Later')
      else draw('unsaved', 'Save to YT Feed Watch Later')
    },
  }
}

const hoverSave = saveControl(saveButton)

/**
 * Click a save button: ask the worker, then answer on the button itself.
 *
 * `stillOn` is re-read AFTER the round trip, because the pointer (or the page)
 * may have moved to another video meanwhile. The save still landed and is now
 * in the Set, but drawing its answer on a button that has since changed hands
 * would report it against the wrong video.
 */
async function clickSave(ctl, id, stillOn) {
  if (!id || ctl.el.disabled) return

  // Deliberately stays put rather than hiding like the open button does. That
  // one hands the video to another tab and is finished; this one's whole reply
  // is the button changing, so there has to be a button to change.
  ctl.el.disabled = true
  const reply = await ask({ type: 'save-watch-later', videoId: id })

  // `saved: false` is the API resolving nothing — a private or deleted video —
  // which is a failure to the person who clicked, whatever the HTTP status was.
  const ok = reply?.ok && reply.saved
  if (ok) saved.add(id)

  const now = stillOn()
  if (now !== id) return ctl.reset(now)

  if (ok) ctl.draw('saved', reply.already ? 'Already in Watch Later' : 'Saved to Watch Later')
  else ctl.draw('failed', `Couldn't save — is the app running?`)
}

document.addEventListener('mouseover', (e) => {
  // Over the button itself — leave it exactly where it is, or hovering it would
  // move it out from under the pointer.
  if (e.target === host) return

  const link = e.target.closest?.('a[href]')
  const id = link && videoId(link.href)
  if (!id) return hide()

  const thumb = thumbnailLink(link, id)
  if (thumb.getBoundingClientRect().width < MIN_THUMB_WIDTH) return hide()

  // Only on a change of video: re-entering the same card (crossing from the
  // thumbnail to its title, say) must not wipe a "couldn't save" you need to
  // read, nor re-run this for every pixel of a card you're already on.
  if (id !== currentId) hoverSave.reset(id)
  anchored = thumb
  currentId = id
  place()

  // Off the back of a hover rather than on a timer, so a tab left open in the
  // background isn't polling the app all day.
  if (Date.now() - askedAt > ASK_EVERY_MS) refreshSaved()
})

// Coming back from another tab is the one moment staleness is likely and
// visible: you just saved or unsaved something in the app itself. Cheaper than
// a shorter timer and better aimed — one request per switch back, not per
// minute of reading.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshSaved(true)
})

// Capture, because YouTube scrolls inner containers (sidebars, chip rows) whose
// scroll events never reach the document otherwise.
let queued = false
addEventListener('scroll', () => {
  if (queued || !anchored) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    place()
  })
}, { capture: true, passive: true })

openButton.addEventListener('click', (e) => {
  // The buttons are siblings of the page rather than children of the card's
  // link, so nothing needs preventing — YouTube's navigation never sees this.
  e.stopPropagation()
  if (currentId) window.open(`${appOrigin}/watch/${currentId}`, APP_TAB)
  hide()
})

saveButton.addEventListener('click', (e) => {
  e.stopPropagation()
  clickSave(hoverSave, currentId, () => currentId)
})

/* ── The watch page ─────────────────────────────────────────
 *
 * The pair above needs a thumbnail to sit on, and the one video a watch page is
 * about hasn't got one — its thumbnail is the player. So a watch page gets a
 * second copy of the same two buttons, in YouTube's own action row, just before
 * the ⋯.
 *
 * That row is the one place on the page that means "things I do to this video",
 * which is what makes it worth the thing this file otherwise refuses to do:
 * naming YouTube's markup. Two mitigations. The anchor is looked up fresh on
 * every sync rather than held, and every lookup is allowed to come back empty —
 * a redesign costs the buttons, not an exception on every watch page. And
 * nothing is pinned to `#top-level-buttons-computed`, which is on THREE
 * elements here, two of them zero-width layout variants, so a plain id lookup
 * picks the wrong one.
 */

const barHost = document.createElement('div')
barHost.style.cssText = 'display:inline-flex;align-items:center;align-self:center'
const barRoot = barHost.attachShadow({ mode: 'open' })

const barStyle = document.createElement('style')
// YouTube's own action-row pill, measured off Share rather than eyeballed: 40px
// tall, 20px radius, rgba(255,255,255,.1) under #f1f1f1 text at 14px/500, with
// 16px of side padding. The dark circle the hover pair wears would read as a
// foreign object here — that one is shaped for sitting on a photograph.
barStyle.textContent = `
  .bar {
    display: flex;
    /* The ⋯ we sit in front of carries exactly this much on its own left. */
    gap: 8px;
    margin-left: 8px;
  }
  button {
    display: inline-flex;
    align-items: center;
    height: 40px;
    padding: 0 16px;
    border: none;
    border-radius: 20px;
    background: rgba(255, 255, 255, 0.1);
    color: #f1f1f1;
    font-family: "Roboto", "Arial", sans-serif;
    font-size: 14px;
    font-weight: 500;
    line-height: 40px;
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.1s;
  }
  button:hover { background: rgba(255, 255, 255, 0.2); }
  button:disabled { cursor: default; }
  /* The icon's own margin rather than a flex gap, because YouTube's pulls
     itself 6px back INTO the padding: a labelled pill is 10px from its left
     edge to the icon and 16px from the label to its right. A 6px gap with
     symmetric padding — the obvious way — sits 6px wider on the left, which is
     enough to read as not-quite-one-of-theirs beside the real ones. */
  svg { width: 24px; height: 24px; display: block; margin: 0 6px 0 -6px; }
  button.failed { background: rgba(153, 27, 27, 0.9); }
  /* Narrow enough that YouTube is already folding its own buttons into the ⋯:
     ours drop their labels rather than push the row wider than the player. With
     no label there's nothing to pull the icon back from, so it re-centres. */
  @media (max-width: 900px) {
    .label { display: none }
    button { padding: 0 8px }
    svg { margin: 0 }
  }
`

const openPill = makeButton('Open in YT Feed', openIcon())
const openLabel = document.createElement('span')
openLabel.className = 'label'
openLabel.textContent = 'YT Feed'
openPill.append(openLabel)

const savePill = makeButton('Save to YT Feed Watch Later', clockIcon())
const barSave = saveControl(savePill, (state) => (state === 'saved' ? 'Saved' : 'Watch Later'))

const bar = document.createElement('div')
bar.className = 'bar'
bar.append(openPill, savePill)
barRoot.append(barStyle, bar)

/** The video a watch page is about, or null if this isn't a watch page. */
function watchId() {
  if (location.pathname !== '/watch') return null
  return new URLSearchParams(location.search).get('v')
}

/** Put the bar back in the action row, unless it's already sitting there. */
function mountBar() {
  const menu = document.querySelector('#actions ytd-menu-renderer')
  if (!menu) return
  // After the Save/Download group is what puts us before the ⋯. Falling back to
  // the like/share row covers a video that offers neither of those.
  const after = menu.querySelector('#flexible-item-buttons')
    ?? [...menu.querySelectorAll('#top-level-buttons-computed')]
      .find((el) => el.getBoundingClientRect().width > 0)
  if (!after || barHost.previousElementSibling === after) return
  after.after(barHost)
}

/** The video the bar currently belongs to, so a save can tell if it moved. */
let barId = null
let barTimer = null

/*
 * A watch page swaps videos without a page load, and YouTube rebuilds that row
 * when it does — so this keeps re-checking for a few seconds after each
 * navigation rather than mounting once and trusting it to stick. `mountBar` is
 * a no-op when nothing moved, so the repeats cost one `querySelector` each.
 */
function syncBar(tries = 12) {
  clearTimeout(barTimer)

  const id = watchId()
  if (!id) {
    barHost.remove()
    barId = null
    return
  }

  if (id !== barId) {
    barId = id
    barSave.reset(id)
  }
  mountBar()
  if (tries > 0) barTimer = setTimeout(() => syncBar(tries - 1), 400)
}

/**
 * The page's main player.
 *
 * The BIGGEST `<video>` on it, because a hovered card in the sidebar is a
 * `<video>` too — just a small one — and `querySelector` would hand back
 * whichever the DOM happens to reach first. Same trick as `thumbnailLink`, and
 * for the same reason: it names no YouTube element.
 */
function mainVideo() {
  let best = null
  let bestWidth = 0
  for (const el of document.querySelectorAll('video')) {
    const width = el.getBoundingClientRect().width
    if (width > bestWidth) {
      best = el
      bestWidth = width
    }
  }
  return best
}

openPill.addEventListener('click', () => {
  if (!barId) return
  const player = mainVideo()

  // Hand over where YouTube had got to, so the app picks up mid-video rather
  // than restarting. Under a few seconds there's nothing worth carrying, and
  // `?t=0` would be worse than silence — it would override the app's own resume
  // position with the top of the video.
  const at = Math.floor(player?.currentTime ?? 0)
  const t = at > HANDOFF_MIN_SEC ? `?t=${at}` : ''

  // Otherwise this tab keeps playing behind the app's copy of the same video.
  player?.pause()

  // The app takes the position from here on. Dropping the pending sample stops
  // this tab reporting a now-older one over the top of the app's, whenever it
  // eventually closes.
  seen = null
  samples = 0

  window.open(`${appOrigin}/watch/${barId}${t}`, APP_TAB)
})

savePill.addEventListener('click', () => clickSave(barSave, barId, () => barId))

/* ── Watch history ──────────────────────────────────────────
 *
 * Watching something on youtube.com writes to the app's history, the same as
 * watching it in the app: the red progress bar on the card, the resume point,
 * and a row on the History page.
 *
 * Only this direction. YouTube has no way in — the Data API has never had a
 * write endpoint for watch history, and the playlist that used to stand in for
 * one was withdrawn years ago. The only thing that would register is a browser
 * actually playing the video, which is a worse idea than the gap it fills.
 *
 * Nothing about the video is read off the page beyond its id: see
 * `reportProgress` in background.js for why.
 */

/* Sampled every second so a video left by an in-page navigation still reports
 * where it actually got to; sent every tenth sample, which matches the app's own
 * watch page, so the two write history at the same granularity. */
const SAMPLE_MS = 1000
const SAMPLES_PER_REPORT = 10

/** Last sampled play head, kept so navigating away can still report it. */
let seen = null // { id, position, duration }
let samples = 0

/*
 * Whether the app wants this at all — the "Record what you watch on youtube.com"
 * switch on its Settings page, cached by the worker.
 *
 * Turned off, the sampler stops entirely rather than sending reports for the
 * app to refuse: an off switch that still watches you and merely discards the
 * answer is not off. The app checks the same setting anyway, which is what
 * covers the up-to-a-minute window where this copy is stale.
 *
 * Starts true so the first sample isn't lost to a round trip; the first refresh
 * lands well inside the ten seconds before anything is sent.
 */
let syncOn = true
let syncAskedAt = 0

async function refreshSync(force = false) {
  syncAskedAt = Date.now()
  const reply = await ask({ type: 'history-sync', force })
  if (reply?.ok) syncOn = reply.enabled
}

/**
 * Whether the player is showing an ad rather than the video.
 *
 * It's the same `<video>` element either way, so without this a pre-roll's
 * play head is reported as the video's — and since ads are short, a 15-second
 * one read against its own duration marks the video finished. `watched` is
 * sticky in the app, so that mistake wouldn't wash out.
 */
function adShowing() {
  return !!document.querySelector('.html5-video-player.ad-showing')
}

function send(sample) {
  ask({
    type: 'report-progress',
    videoId: sample.id,
    position: sample.position,
    duration: sample.duration,
  })
}

function sample() {
  // Re-read on the sampler's own tick rather than on a second timer: a tab
  // that isn't playing anything never asks, and one that is asks once a minute.
  if (Date.now() - syncAskedAt > ASK_EVERY_MS) refreshSync(true)
  if (!syncOn) return

  // `watchId` is /watch only, so Shorts report nothing — they're a
  // scroll-through, and a page of them would bury everything else in history
  // within a minute.
  const id = watchId()
  const player = mainVideo()
  if (!id || !player || player.paused || player.ended || adShowing()) return

  const position = player.currentTime
  if (!position) return
  seen = { id, position, duration: Math.round(player.duration) || 0 }

  // Counted in samples rather than wall clock, so ten seconds means ten seconds
  // of playback — a paused tab left open overnight reports nothing.
  if (++samples >= SAMPLES_PER_REPORT) {
    samples = 0
    send(seen)
  }
}

/** Report where the last video got to, if that hasn't been said already. */
function flushHistory() {
  if (!seen) return
  send(seen)
  samples = 0
  seen = null
}

refreshOrigin()
setInterval(sample, SAMPLE_MS)

// Closing the tab, or a real navigation out of it. `pagehide` rather than
// `beforeunload` because a page restored from the back/forward cache never
// fires the latter.
addEventListener('pagehide', flushHistory)

/* ── Channel pages ──────────────────────────────────────────
 *
 * The app's feed is the videos of the channels it holds, and until now the only
 * way in was your YouTube subscription list. So: a channel page gets a pill that
 * adds the channel you're looking at, subscribed or not.
 *
 * It sits in `yt-flexible-actions-view-model`, the header's own row of
 * per-channel actions — Subscribe, Join, and whatever else that channel offers.
 * Anchoring to the ROW rather than to the Subscribe button is deliberate: the
 * button's label is localised and changes once you're subscribed, so anything
 * that recognised it by its text would work in English and nowhere else.
 */

/* The channel URL shapes: current (@handle), canonical (/channel/UC…), and the
 * two legacy vanity forms. A trailing tab (/videos, /streams) is still one. */
const CHANNEL_PATH_RE = /^\/(?:@[^/]+|channel\/UC[\w-]{22}|c\/[^/]+|user\/[^/]+)(?:\/|$)/

/** The channel this page is about: {url, id}, or null if it isn't one. */
function channelPage() {
  if (!CHANNEL_PATH_RE.test(location.pathname)) return null
  // The canonical link is always the /channel/UC… form whatever URL you came in
  // by, which is how a page reached by handle knows its own id. On a page that
  // hasn't got one, the app resolves the URL server-side; only the "already
  // added" tick needs the id up front.
  const canonical = document.querySelector('link[rel="canonical"]')?.href ?? ''
  const m = canonical.match(/\/channel\/(UC[\w-]{22})/)
  return {
    url: `${location.origin}${location.pathname}`,
    id: m ? m[1] : null,
  }
}

const channelHost = document.createElement('div')
channelHost.style.cssText = 'display:inline-flex;align-items:center;align-self:center'
const channelRoot = channelHost.attachShadow({ mode: 'open' })
// The same pill as the watch page's, because it's going in the same kind of
// place — a row of YouTube's own action buttons — and a second set of numbers
// would only be a second thing to keep in step.
channelRoot.append(barStyle.cloneNode(true))

function plusIcon() {
  const el = svg('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' })
  el.append(svg('path', {
    d: 'M12 6v12M6 12h12', stroke: 'currentColor', 'stroke-width': 2,
    'stroke-linecap': 'round',
  }))
  return el
}

const addPill = makeButton('Add this channel to YT Feed', plusIcon())
const addBar = document.createElement('div')
addBar.className = 'bar'
addBar.append(addPill)
channelRoot.append(addBar)

/**
 * Which channels the app already holds, so the pill can say so on arrival.
 *
 * Same shape as `saved` above and for the same reason: the header paints before
 * any answer could come back, so it reads a Set held here and the worker owns
 * how fresh that Set is.
 */
const known = new Set()
let knownAskedAt = 0

/** The channel the pill currently belongs to, so an add can tell if it moved. */
let channelId = null
let channelUrl = null
let channelTimer = null

function drawAdd(state, title) {
  addPill.disabled = state === 'added'
  addPill.classList.toggle('failed', state === 'failed')
  addPill.replaceChildren(state === 'added' ? tickIcon() : plusIcon())
  const span = document.createElement('span')
  span.className = 'label'
  span.textContent = state === 'added' ? 'In YT Feed' : 'YT Feed'
  addPill.append(span)
  addPill.title = title
}

/** The pill as it should look for a channel we haven't just clicked it for. */
function resetAdd() {
  if (channelId && known.has(channelId)) drawAdd('added', 'Already in YT Feed')
  else drawAdd('absent', 'Add this channel to YT Feed')
}

async function refreshKnown(force = false) {
  knownAskedAt = Date.now()
  const reply = await ask({ type: 'channel-ids', force })
  if (!reply?.ok) return
  known.clear()
  for (const id of reply.ids) known.add(id)
  if (!addPill.classList.contains('failed')) resetAdd()
}

/** Put the pill back in the header's action row, unless it's already there. */
function mountAdd() {
  // Widest visible one: the same trick as `mainVideo`, because a channel page
  // can carry more than one of these rows and the hidden ones measure zero.
  const row = [...document.querySelectorAll('yt-flexible-actions-view-model')]
    .filter((el) => el.getBoundingClientRect().width > 0)[0]
  if (!row || channelHost.parentElement === row) return
  row.append(channelHost)
}

/*
 * Re-checks for a few seconds after each navigation, exactly like `syncBar` —
 * YouTube rebuilds the header when you move between channels, and the canonical
 * link that carries the id lands some time after the URL does.
 */
function syncAdd(tries = 12) {
  clearTimeout(channelTimer)

  const page = channelPage()
  if (!page) {
    channelHost.remove()
    channelId = null
    channelUrl = null
    return
  }

  channelUrl = page.url
  if (page.id !== channelId) {
    channelId = page.id
    resetAdd()
  }
  mountAdd()
  if (tries > 0) channelTimer = setTimeout(() => syncAdd(tries - 1), 400)
}

addPill.addEventListener('click', async () => {
  if (!channelUrl || addPill.disabled) return
  const url = channelUrl
  addPill.disabled = true
  const reply = await ask({ type: 'add-channel', url })

  if (reply?.ok && reply.youtube_id) known.add(reply.youtube_id)

  // The header may have moved to another channel during the round trip — the
  // add still landed, but its answer belongs to the channel it was about.
  if (channelUrl !== url) return resetAdd()

  if (reply?.ok) {
    // A page reached by handle may not have surrendered an id yet; the reply
    // carries the one the app resolved, so the tick survives the next redraw.
    channelId = reply.youtube_id ?? channelId
    drawAdd('added', reply.already ? 'Already in YT Feed' : 'Added to YT Feed')
  } else {
    drawAdd('failed', `Couldn't add — is the app running?`)
  }
})

// Fired by YouTube's own router on every in-page navigation.
addEventListener('yt-navigate-finish', () => {
  // Before anything else: the player is already on the new video, so the last
  // sample is the only remaining record of where the old one got to.
  if (seen && seen.id !== watchId()) flushHistory()
  syncBar()
  syncAdd()
})

// Coming back from the app is when this is most likely to be stale — you may
// have just added or removed the very channel you're looking at.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  if (Date.now() - knownAskedAt > ASK_EVERY_MS) refreshKnown(true)
  // The same argument applies to the history switch, and more sharply: coming
  // back from the app is when you'd have just flipped it.
  refreshSync(true)
})

document.documentElement.append(host)
syncBar()
refreshSaved()
syncAdd()
refreshKnown()
