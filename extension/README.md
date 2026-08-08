# YT Feed companion

An **optional** browser extension. It does two unrelated things, each on a
different site:

- on **the app**, it removes YouTube's overlays from embedded players so the app
  can draw its own control bar over bare video;
- on **youtube.com**, it puts an *open in YT Feed* button on the corner of every
  video thumbnail.

The app works without it. Everything below is additive, and the no-extension
behaviour is the default that ships.

| File | Runs on | Does |
|---|---|---|
| `embed.css` | `youtube.com/embed/*`, all frames | Hides the player chrome |
| `marker.js` | `localhost`, `127.0.0.1` | Sets `data-ytfeed-embed-clean="1"` on `<html>` |
| `open-in-app.js` | `youtube.com/*` | The corner button on video cards |

## Open in YT Feed

Hover any video thumbnail on YouTube — home, search, a channel, the sidebar of a
watch page — and a small button appears in its top-left corner. Clicking it
opens that video in the app rather than on YouTube. Repeat clicks reuse a single
app tab instead of piling up new ones.

It reads `APP_ORIGIN` at the top of `open-in-app.js`, which is Vite's default
`http://localhost:5173`. **If you run the app on another port, change that
line** — it takes effect on the next page load, and there's nothing to rebuild.
That's a constant rather than a settings page on purpose: an options page means
a `storage` permission and two more files to answer a question that has one
answer for the life of an install.

### Why one floating button and not one per card

There is exactly one button element. It's parked off-screen and moved onto
whatever the pointer is over.

Injecting a button into each card is the obvious alternative and a worse one: it
needs a `MutationObserver`, it has to *name* the card elements it injects into,
and YouTube's lists are virtualised — it **recycles** card nodes as you scroll,
so an injected button ends up on the wrong video. Moving one element sidesteps
all three.

The only YouTube fact it depends on is the URL shape of a video link, `/watch?v=`
and `/shorts/`, which has outlived every generation of the site's markup. It
never names a renderer element. To find the thumbnail of the card you're hovering
— you might be on the title — it climbs a few ancestors and takes the *widest*
link to the same video. Widest matters: search results expand a card into a
chapter list, and every chapter is another link to the same video with its own
small image, so "first one with an image in it" picks the wrong element.

It's styled to pass for the mute and captions buttons YouTube floats over a
thumbnail's hover preview — a plain dark circle, white icon, no text. The
numbers are copied from the rule that draws those,
`.ytInlinePlayerControlsTopRightControlsCircleButton`:

```css
color: rgb(255, 255, 255); background: rgba(0, 0, 0, 0.6);
border-radius: 50%; width: 40px; height: 40px;   /* icon 24px, inset 8px */
```

The one deliberate difference is the hover state. YouTube's pair has none —
they're a permanent fixture on a playing video — but ours only appears on hover
and is the one clickable thing on the thumbnail, so it darkens to `.9` to answer
the pointer.

Three details worth knowing if you touch this file:

- The button lives in a **shadow root**, so YouTube's stylesheets can't restyle
  it and its own can't leak out.
- It's built with `createElement` rather than `innerHTML` because youtube.com
  sets `require-trusted-types-for 'script'`, under which an `innerHTML`
  assignment throws. Chrome does normally exempt a content script's isolated
  world from the page's CSP, but that exemption has broken before and this code
  owes it nothing.
- The button carries a `title` rather than a visible label, matching the buttons
  it's modelled on.

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

It's unpacked and unbuilt — four files, no toolchain.

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select this `extension/` directory
4. Reload the app

To confirm it took, run this in the app's console — `true` means it's active:

```js
document.documentElement.dataset.ytfeedEmbedClean === '1'
```

For the YouTube half, just hover a thumbnail on youtube.com and look for the
button. Nothing needs reloading beyond the YouTube tab itself.

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
