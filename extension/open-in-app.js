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
 * Where the app is served. Vite's default; change this line if you run it
 * somewhere else (it takes the next page load, no rebuild). Deliberately a
 * constant rather than a stored setting: an options page would mean a storage
 * permission and two more files to answer a question that has one answer for
 * the life of an install.
 */
const APP_ORIGIN = 'http://localhost:5173'

/* Named so repeat clicks REUSE one app tab rather than piling up tabs. */
const APP_TAB = 'ytfeed'

/* Below this, a link is a chip or a text mention rather than a video card. */
const MIN_THUMB_WIDTH = 80

/* Inset from the thumbnail's corner, matching YouTube's own overlay buttons. */
const INSET = 8

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

async function refreshSaved(force = false) {
  askedAt = Date.now()
  const reply = await chrome.runtime.sendMessage({ type: 'saved-ids', force })
  if (!reply?.ok) return
  saved.clear()
  for (const id of reply.ids) saved.add(id)
  // The video under the pointer may be one of them, and it isn't going to be
  // hovered again just because we finally know.
  if (currentId && !saveButton.classList.contains('failed')) hoverSave.reset(currentId)
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
  const reply = await chrome.runtime.sendMessage({ type: 'save-watch-later', videoId: id })

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
  if (currentId) window.open(`${APP_ORIGIN}/watch/${currentId}`, APP_TAB)
  hide()
})

saveButton.addEventListener('click', (e) => {
  e.stopPropagation()
  clickSave(hoverSave, currentId, () => currentId)
})

document.documentElement.append(host)
refreshSaved()
