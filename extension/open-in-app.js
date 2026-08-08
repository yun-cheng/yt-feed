/*
 * "Open in YT Feed" — a button on the corner of a YouTube video card.
 *
 * Hover any thumbnail on youtube.com and a small button appears in its top-left
 * corner; clicking it opens that video in the app instead of on YouTube.
 *
 * There is exactly ONE button, parked off-screen and moved onto whatever the
 * pointer is over. The obvious alternative — inject a button into every card —
 * needs a MutationObserver, has to name the card elements it's injecting into,
 * and then fights YouTube's virtualised lists, which RECYCLE those nodes as you
 * scroll (so the button follows the wrong video). Moving one element sidesteps
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
// they're a permanent fixture on a playing video — but this appears on hover
// and is the only thing here you can click, so it answers the pointer.
style.textContent = `
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
  svg { width: 24px; height: 24px; display: block; }
`

const button = document.createElement('button')
button.type = 'button'
// Icon-only, like the buttons it's modelled on, so the tooltip carries the name.
button.title = 'Open in YT Feed'
button.setAttribute('aria-label', 'Open in YT Feed')

const icon = svg('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' })
icon.append(
  svg('rect', {
    x: 3, y: 4, width: 18, height: 16, rx: 3,
    stroke: 'currentColor', 'stroke-width': 2,
  }),
  svg('path', { d: 'M10 9.5v5l4-2.5z', fill: 'currentColor' }),
)
button.append(icon)
root.append(style, button)

/** The link the button is currently parked on, so scrolling can follow it. */
let anchored = null
let currentId = null

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

document.addEventListener('mouseover', (e) => {
  // Over the button itself — leave it exactly where it is, or hovering it would
  // move it out from under the pointer.
  if (e.target === host) return

  const link = e.target.closest?.('a[href]')
  const id = link && videoId(link.href)
  if (!id) return hide()

  const thumb = thumbnailLink(link, id)
  if (thumb.getBoundingClientRect().width < MIN_THUMB_WIDTH) return hide()

  anchored = thumb
  currentId = id
  place()
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

button.addEventListener('click', (e) => {
  // The button is a sibling of the page rather than a child of the card's link,
  // so nothing needs preventing — YouTube's own navigation never sees this.
  e.stopPropagation()
  if (currentId) window.open(`${APP_ORIGIN}/watch/${currentId}`, APP_TAB)
  hide()
})

document.documentElement.append(host)
