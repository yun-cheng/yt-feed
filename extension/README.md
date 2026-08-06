# YT Feed — clean embed

An **optional** browser extension. It removes YouTube's overlays from embedded
players so the app can draw its own control bar over bare video.

The app works without it. Everything below is additive, and the no-extension
behaviour is the default that ships.

## What it does

The app already passes `controls=0` to every embed. That turns off the control
*bar* and nothing else — the channel avatar and title stay across the top, the
"Includes paid promotion" badge with them, a play/pause button sits in the
middle, and a share / watch-later / "More videos" / watch-on-YouTube row runs
along the bottom. The embed API has no switch for any of it; `modestbranding`
and `showinfo` were the old ones and both are dead.

Nothing in a web page can reach inside a cross-origin iframe to remove them.
A content script can, so this is one:

| File | Runs on | Does |
|---|---|---|
| `embed.css` | `youtube.com/embed/*`, all frames | Hides the chrome |
| `marker.js` | `localhost`, `127.0.0.1` | Sets `data-ytfeed-embed-clean="1"` on `<html>` |

## Install

It's unpacked and unbuilt — three files, no toolchain.

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select this `extension/` directory
4. Reload the app

To confirm it took, run this in the app's console — `true` means it's active:

```js
document.documentElement.dataset.ytfeedEmbedClean === '1'
```

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

## The one fragile thing

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
