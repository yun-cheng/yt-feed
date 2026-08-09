# YT Feed companion

An **optional** browser extension. It does two unrelated things, each on a
different site:

- on **the app**, it removes YouTube's overlays from embedded players so the app
  can draw its own control bar over bare video;
- on **youtube.com**, it puts *open in YT Feed* and *save to Watch Later*
  buttons on the corner of every video thumbnail.

The app works without it. Everything below is additive, and the no-extension
behaviour is the default that ships.

| File | Runs on | Does |
|---|---|---|
| `embed.css` | `youtube.com/embed/*`, all frames | Hides the player chrome |
| `marker.js` | `localhost`, `127.0.0.1` | Sets `data-ytfeed-embed-clean="1"` on `<html>` |
| `open-in-app.js` | `youtube.com/*` | The corner buttons on cards, and the watch-page pair |
| `background.js` | service worker | Talks to the app's API, and caches the Watch Later list |

## Open in YT Feed, and Save to Watch Later

Hover any video thumbnail on YouTube — home, search, a channel, the sidebar of a
watch page — and two small buttons appear, stacked, in its top-left corner.

The first opens that video in the app rather than on YouTube. Repeat clicks
reuse a single app tab instead of piling up new ones.

The second saves it to the app's Watch Later without leaving the page you're on,
and is the only thing here that talks to the app rather than just linking to it.
It answers in place: the clock becomes a **tick** — same circle, same fill, so a
column of thumbnails still reads as one set of controls rather than a scoreboard.
The one coloured state is a failed save, which goes red because it's the only
thing here you have to *notice* rather than merely read; it clears the moment you
hover a different video. The tick doesn't, because it isn't a flash of feedback
but the answer to "have I got this one already".

### The tick you get before you click

Hovering a video that's already on the list shows the tick straight away. That
comes from a copy of the list, not from a request per hover: a request can't
answer before you've looked, so the button would still have to draw a guess
first — and hovering is something you do dozens of times per scroll.

What's cached is **the list itself**, refreshed from `GET /api/watch-later`,
rather than a private tally of what this extension saved. A tally would be wrong
twice over: blind to anything you saved in the app, and still claiming "saved"
after you removed something there. One small GET buys the true answer, so
there's nothing to gain by tracking a subset of it.

It re-reads the list when it's more than a minute old (checked on hover, so a
tab left open in the background isn't polling all day) and, unconditionally,
**whenever the tab is switched back to** — coming back from the app is exactly
when it's most likely to be out of date, and it costs one request per switch
rather than one per minute of reading. A save updates the copy directly, so the
tick survives scrolling past the card and back.

The list is kept in `chrome.storage.local` as well as in the worker's memory,
because an MV3 service worker is evicted after ~30s idle. That also means the
ticks still show when the app is closed — the last known list beats no list, and
the save itself still goes to the API, which is what actually decides.

It reads `APP_ORIGIN` at the top of `open-in-app.js`, which is Vite's default
`http://localhost:5173`. **If you run the app on another port, change that
line** — it takes effect on the next page load, and there's nothing to rebuild.
That's a constant rather than a settings page on purpose: an options page means
a `storage` permission and two more files to answer a question that has one
answer for the life of an install. `background.js` holds the same constant —
**change both** or the button opens the wrong port while the save still works,
which reads as a baffling bug. A service worker and a content script share no
scope short of adding a module loader to a five-file, no-build extension.

### Why the save goes through a service worker

A `fetch` from `open-in-app.js` carries `Origin: https://www.youtube.com`, and
the API allows the app's own origin only — so the browser discards the reply. A
fetch from the service worker isn't subject to CORS at all; the extension's
`host_permissions` (`localhost` and `127.0.0.1`, any port) are the check
instead. That's the whole reason `background.js` exists: it answers two
messages, `save-watch-later` and `saved-ids`, and owns the cached list behind
them. `storage` is the only permission it needs beyond those hosts.

The request itself is a bare `POST /api/watch-later/by-id/<id>`. The button
knows an id and nothing else, and deliberately doesn't scrape a title and
channel name out of YouTube's markup — the backend resolves the metadata by the
same lookup the watch page uses (see `backend/README.md`). Markup changes; the
URL shape of a video link doesn't.

### Why one floating pair and not one per card

There are exactly two button elements. They're parked off-screen and moved onto
whatever the pointer is over.

Injecting buttons into each card is the obvious alternative and a worse one: it
needs a `MutationObserver`, it has to *name* the card elements it injects into,
and YouTube's lists are virtualised — it **recycles** card nodes as you scroll,
so injected buttons end up on the wrong video. Moving one element sidesteps
all three.

The only YouTube fact it depends on is the URL shape of a video link, `/watch?v=`
and `/shorts/`, which has outlived every generation of the site's markup. It
never names a renderer element. To find the thumbnail of the card you're hovering
— you might be on the title — it climbs a few ancestors and takes the *widest*
link to the same video. Widest matters: search results expand a card into a
chapter list, and every chapter is another link to the same video with its own
small image, so "first one with an image in it" picks the wrong element.

They're styled to pass for the mute and captions buttons YouTube floats over a
thumbnail's hover preview — a plain dark circle, white icon, no text — which is
also a stacked pair, 8px apart. The numbers are copied from the rule that draws
those,
`.ytInlinePlayerControlsTopRightControlsCircleButton`:

```css
color: rgb(255, 255, 255); background: rgba(0, 0, 0, 0.6);
border-radius: 50%; width: 40px; height: 40px;   /* icon 24px, inset 8px */
```

The one deliberate difference is the hover state. YouTube's pair has none —
they're a permanent fixture on a playing video — but ours only appear on hover
and are the only clickable things on the thumbnail, so they darken to `.9` to
answer the pointer.

Three details worth knowing if you touch this file:

- The buttons live in a **shadow root**, so YouTube's stylesheets can't restyle
  them and their own can't leak out.
- They're built with `createElement` rather than `innerHTML` because youtube.com
  sets `require-trusted-types-for 'script'`, under which an `innerHTML`
  assignment throws. Chrome does normally exempt a content script's isolated
  world from the page's CSP, but that exemption has broken before and this code
  owes it nothing.
- They carry a `title` rather than a visible label, matching the buttons they're
  modelled on. The save button's tooltip doubles as its result message.

### On the watch page

The hover pair needs a thumbnail to sit on, and the one video a watch page is
*about* hasn't got one — its thumbnail is the player. So a watch page carries a
second copy of the same two buttons, in YouTube's own action row, **just before
the `⋯`**:

> 👍 19M ｜ 👎 ｜ Share ｜ Save ｜ **▶ YT Feed ｜ 🕐 Watch Later** ｜ ⋯

That row is the one place on the page meaning "things I do to this video", which
is what makes it worth doing the thing this file otherwise refuses to do:
**naming YouTube's markup**. Two mitigations. The anchor is looked up fresh on
every sync rather than held, and every lookup may come back empty — a redesign
costs the buttons, not an exception on every watch page.

They're pills rather than dark circles, measured off Share: 40px tall, 20px
radius, `rgba(255,255,255,.1)` under `#f1f1f1` at 14px/500, `0 16px` padding.
The circle is shaped for sitting on a photograph and would read as a foreign
object in a text row. Under 900px the labels drop and they become icon-only,
which is roughly where YouTube starts folding its own buttons into the `⋯`.

The one non-obvious number is the icon's `margin: 0 6px 0 -6px`. YouTube's icon
pulls itself 6px back *into* the button's padding, so a labelled pill measures
**10px** from its left edge to the icon and 16px from the label to its right.
Reaching for `gap: 6px` with symmetric padding — the obvious way — sits 6px
wider on the left, which is enough to read as not-quite-one-of-theirs when it's
sitting next to the real ones. With the label hidden there's nothing to make
room for, so the narrow rule puts the margin back to zero.

Two traps, both real, both hit while building this:

- **`#top-level-buttons-computed` is on three elements**, two of them zero-width
  layout variants — so `querySelector` returns the wrong one. The anchor is
  `#flexible-item-buttons` (the Save/Download group), and the fallback picks the
  like/share row *by measured width* rather than by id.
- **YouTube rebuilds that row**, both on in-page navigation and on its own. So
  `syncBar` re-checks for ~5s after every `yt-navigate-finish` rather than
  mounting once; re-mounting is a no-op when nothing moved.

The open button hands over **where you'd got to**, as `/watch/:id?t=<seconds>`,
so the app picks up mid-video rather than restarting. Under 5s in there's
nothing worth carrying, and `?t=0` would be worse than silence — it would
override the app's own resume position with the top of the video. It also
pauses YouTube's player on the way out, or this tab keeps playing behind the
app's copy of the same thing.

Which `<video>` is "the player" is decided by **size**: a hovered card in the
sidebar is a `<video>` too, so `mainVideo()` takes the widest one on the page.
Same trick as `thumbnailLink`, and for the same reason — it names no YouTube
element.

## Clean embed

The app already passes `controls=0` to every embed. That turns off the control
*bar* and nothing else — the channel avatar and title stay across the top, the
"Includes paid promotion" badge with them, a play/pause button sits in the
middle, and a share / watch-later / "More videos" / watch-on-YouTube row runs
along the bottom. The embed API has no switch for any of it; `modestbranding`
and `showinfo` were the old ones and both are dead.

Nothing in a web page can reach inside a cross-origin iframe to remove them.
A content script can, so `embed.css` is one.

## Install

It's unpacked and unbuilt — five files, no toolchain.

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select this `extension/` directory
4. Reload the app

To confirm it took, run this in the app's console — `true` means it's active:

```js
document.documentElement.dataset.ytfeedEmbedClean === '1'
```

For the YouTube half, just hover a thumbnail on youtube.com and look for the
buttons. Nothing needs reloading beyond the YouTube tab itself — but **after
editing `background.js` you have to reload the extension** at
`chrome://extensions`, because a service worker isn't re-read per page.

Chrome, Edge, Arc and other Chromium browsers take it as-is. Firefox loads it
via `about:debugging` → **Load Temporary Add-on**.

## How the app finds out

`marker.js` sets a `data-` attribute at `document_start`, and the app reads it
synchronously at boot (`frontend/src/lib/ext.ts`).

The timing is the reason it's an attribute rather than a message. `controls` is
a playerVar, baked into the iframe URL when the player is constructed — an
answer arriving one round-trip later arrives too late. A `document_start`
content script runs before any page script, so the flag is simply *there*. It
also keeps this browser-agnostic and needs no pinned extension ID, which
`chrome.runtime` messaging would.

The app caches the answer for the life of the page. Installing or removing the
extension takes effect on the next reload — which is when the stylesheet takes
effect anyway.

## The one fragile thing (`embed.css`)

All the chrome lives in a single container, `#player-controls`, which is a
**sibling** of `#movie_player` rather than a child. That's why `embed.css` is
three rules instead of a selector war — and it's also why hiding it is safe: the
video element and the IFrame API are in the other subtree entirely, so nothing
here can reach them. The app keeps driving the player exactly as it does with no
extension installed.

But it *is* one ID against a UI that YouTube rewrites. It has already replaced
the old `.ytp-chrome-top` / `.ytp-pause-overlay` / `.ytp-ce-element` /
`.ytp-large-play-button` markup wholesale — none of those elements exist any
more. When that happens again, this stylesheet silently stops matching and
YouTube's chrome comes back *underneath* the app's own bar.

**So: if YouTube's controls reappear over the video, suspect this file first.**
Re-derive the selectors by opening an embed and looking at what's actually
there. Note that a top-level `/embed/` URL returns **Error 153** unless it has a
referrer — navigate to it from another page rather than typing it in.

The recovery is always available: uninstall the extension and reload. The app
drops back to YouTube's own controls, which is a supported path, not a
degraded one.
