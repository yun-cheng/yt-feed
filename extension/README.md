# YT Feed companion

An **optional** browser extension. It does two unrelated things, each on a
different site:

- on **the app**, it removes YouTube's overlays from embedded players so the app
  can draw its own control bar over bare video;
- on **youtube.com**, it puts *open in YT Feed* and *save to Watch Later*
  buttons on the corner of every video thumbnail, an *add this channel* pill on
  every channel page, and it writes what you watch there into the app's own
  watch history.

The app works without it. Everything below is additive, and the no-extension
behaviour is the default that ships.

| File | Runs on | Does |
|---|---|---|
| `embed.css` | `youtube.com/embed/*`, all frames | Hides the player chrome |
| `marker.js` | `localhost`, `127.0.0.1` | Sets `data-ytfeed-embed-clean="1"` on `<html>`, and hands the worker the app's address and this browser's API key |
| `open-in-app.js` | `youtube.com/*` | The corner buttons on cards, the watch-page pair, the channel-page pill, and the watch-history sampler |
| `background.js` | service worker | Talks to the app's API, owns the configuration, and caches the Watch Later list and the channel list |
| `options.html` / `options.js` | extension options | The app's address and your API key |

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
instead. That's the whole reason `background.js` exists: it answers five
messages — `save-watch-later` / `saved-ids` for videos, `add-channel` /
`channel-ids` for channels, `report-progress` / `history-sync` for watch history
— and owns the cached lists behind them. `storage` is the only permission it
needs beyond those hosts.

Every one of those goes through `ask()` rather than `chrome.runtime.sendMessage`
directly, because that call **rejects** when the messaging itself fails, and two
of those failures are ordinary rather than exceptional: the worker is asleep, or
— the common one while developing — the extension has just been reloaded, which
leaves the copy of the content script already running in an open tab holding a
dead handle (*"Extension context invalidated"*). `ask()` turns both into a
`null` reply, which every caller already reads as "the app didn't answer" and
draws as the button's failed state. Without it the rejection is unhandled, and
since two of the calls are made unawaited at startup it surfaces as an uncaught
error against whichever line did the `await` — a console full of noise about a
tab that just needs reloading.

That reload is also the fix if you ever see *"Identifier 'APP_ORIGIN' has
already been declared"*: it means this script ran twice in one document, and the
second run's top-level `const` collided with the first's. Nothing in the script
can guard against it — a redeclaration is a parse-time error, raised before any
code of ours runs.

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

## Watch history, from YouTube into the app

Watching something on youtube.com writes to the app's history, the same as
watching it in the app: the red progress bar on the card, the resume point, and
a row on the History page. There's no button for it — it's what the watch page
does while you're on it.

**Only this direction**, by decision rather than by accident. The Data API has
never had a write endpoint for watch history, and the playlist that used to
stand in for one (`HL`) was withdrawn years ago, so there is nothing to POST to.
The only thing that registers is a browser playing the video for real, and
Chrome will not load media in a hidden tab — so it cannot be done quietly in the
background. It would have to take the foreground, on a tab you didn't ask for,
every time you finished something.

That was measured rather than guessed, along with three other routes that all
turned out to be closed:
[docs/youtube-history-writeback.md](../docs/youtube-history-writeback.md) has
what each one did. The conclusion was that the cost is worse than the gap, so
this half doesn't exist.

### Turning it off

The switch is **"Record what you watch on youtube.com"** on the app's own
Settings page, not in an options page here. What it governs is what gets written
to the app's database, and the app is where you'd go looking for it — which is
also why the extension still has no options page and no second place for
settings to live.

Off, the sampler **stops**. It doesn't keep watching and let the app refuse the
answers: an off switch that still watches you and merely discards the result is
not off. The extension reads the flag through the worker's cache, the same way
it reads the Watch Later and channel lists, refreshed once a minute off the
sampler's own tick (a tab playing nothing never asks) and whenever you switch
back to a YouTube tab — which is when you'd have just flipped it.

The app checks the same setting on the endpoint. That's the backstop, not the
mechanism: it covers the up-to-a-minute window where this copy is stale, so a
report already in flight when you flip the switch is refused rather than
written. It's checked before the metadata lookup, or turning the feature off
would still cost a YouTube fetch.

An unreachable app answers *on*. A report sent while it's down fails harmlessly,
whereas defaulting to *off* would quietly disable the feature for a minute every
time the app restarted.

### How often it reports

The play head is sampled **every second** and sent **every tenth sample**, which
is the same granularity the app's own watch page reports at. Two reasons it isn't
simply a ten-second timer:

- Ten samples means ten seconds of *playback*, not of wall clock — a paused tab
  left open overnight reports nothing.
- A watch page swaps videos without a page load, and by the time
  `yt-navigate-finish` fires the player is already on the new one. The last
  sample is then the only remaining record of where the old video got to, so
  navigation flushes it. Sampling once a second bounds what that loses to a
  second; a ten-second timer would lose up to ten.

`pagehide` flushes it too — that rather than `beforeunload`, which a page
restored from the back/forward cache never fires.

**Ads are skipped**, on `.html5-video-player.ad-showing`. It's the same `<video>`
element either way, so without that check a pre-roll's play head is reported as
the video's — and since ads are short, a 15-second one read against its own
duration marks the video *finished*. `watched` is sticky in the app, so that
mistake wouldn't wash out on the next report.

Shorts are left out. They're a scroll-through, and a page of them would bury
everything else in History within a minute.

Clicking **Open in YT Feed** drops the pending sample, because from that point
the app owns the position: otherwise, whenever this tab eventually closed, it
would flush a now-older position over the top of the app's newer one.

What goes over is the video id and the play head, nothing else — `POST
/api/history/by-id/<id>`, and the app resolves the title, channel and thumbnail
itself. That's the same bargain the Watch Later button strikes, and here there's
a second reason: YouTube's watch page gives a content script no dependable
channel id. The `<meta itemprop>` block has the video's id, its publish date and
its counts, but not the channel's; the owner link is a `/@handle`; and the one
place the id does appear is a Polymer property on the subscribe button, which an
isolated world can't read. The backend already knows every video from a channel
you hold, and resolves the rest once.

## Add this channel to YT Feed

The app's feed is the videos of the channels it holds, and its subscription list
is only one way in. So a **channel page** — `/@handle`, `/channel/UC…`, and the
legacy `/c/` and `/user/` forms, on any of their tabs — gets one more pill, in
the header's own row of actions:

> **Subscribe ｜ + YT Feed**

The anchor is `yt-flexible-actions-view-model`, which is that row: Subscribe,
Join, and whatever else the channel offers. Anchoring to the **row** rather than
to the Subscribe button is the point — the button's label is localised and
changes once you're subscribed, so anything that recognised it by its text would
work in English and nowhere else. As on the watch page, the row is looked up
fresh on every sync, the widest visible one wins (a channel page can carry more
than one, and the hidden ones measure zero), and a lookup is allowed to come
back empty.

The pill knows whether the channel is already in the app, the same way the save
button knows about Watch Later: the service worker caches
`GET /api/channels` and hands the id list over, so the header can paint
"In YT Feed" the instant it renders instead of after a round trip. A click posts
the **page's URL** — the app resolves handles, ids and vanity URLs itself, so
there's nothing to work out on this side.

The channel's id comes from `link[rel="canonical"]`, which is always the
`/channel/UC…` form whatever URL you arrived by. A page that hasn't surrendered
one yet can still be added; only the "already in" tick needs it up front, and the
reply carries the id the app resolved so the tick survives the next redraw.

## Import to YT Feed

A **playlist page** — `/playlist?list=…` — gets a pill beside Play all and
Shuffle that copies the whole thing into the app.

The app can already pull playlists over the YouTube Data API — by listing the
ones your account created, and by taking a pasted link for any **public**
playlist besides. So this exists for the remainder, which the API won't serve at
any price: **Watch Later**, **Liked Videos** (both withdrawn in 2016), and
anyone's **private** playlist. It also exists for the people who have no Google
connection — on a household install that's everyone but one.

This button reads the page **as you**: whatever you can see on youtube.com,
signed in as whoever you are, at no quota cost.

### Why it fetches the page instead of reading the DOM

A playlist page renders about a hundred rows and recycles them as you scroll. So
scraping what's on screen gets you a hundred videos out of five hundred — and no
way to tell that it did.

Instead the click fetches `/playlist?list=…` fresh for its `ytInitialData` (the
JSON the page bootstrapped from: the first hundred items plus a continuation
token), then walks the rest through YouTube's own `/youtubei/v1/browse`. Both
fetches are same-origin and carry your cookies, so they see exactly what your
browser sees. A 505-video playlist arrives in six requests.

The pill says how many it read, and says so explicitly when the walk stopped
early rather than presenting a partial import as a whole one.

### The shapes, and why the readers are loose

Every field was read off a live playlist page rather than guessed, and YouTube
has already moved two of them:

| what | was | is |
| --- | --- | --- |
| a playlist row | `playlistVideoRenderer` | `lockupViewModel` |
| "there's more" | `continuationItemRenderer.continuationEndpoint` | `continuationItemViewModel.continuationCommand.innertubeCommand` |

So the readers search for a shape rather than walking a fixed path, and accept
both spellings. The continuation finder keys on the one thing both have in
common: a `continuationCommand` holding a token, wherever it sits.

Two details that look like details and aren't:

- **The channel is the metadata part that links to a channel.** A lockup's
  metadata rows hold the channel, the view count and the age as interchangeable
  parts whose order is *not* stable — on a channel's uploads page part 0 is the
  channel, on a continuation page it's "95K views". Taking part 0 gives you
  playlists uploaded by "95K views".
- **A visible action row can measure zero wide.** The current one is a flex
  container that's 0×40, so the mount test accepts either dimension. Testing
  width alone — which is right for the channel header — finds nothing here.

If every known anchor is missing after a redesign, the pill floats bottom-right
instead. A button in a slightly odd place beats a feature that silently isn't
there.

### What travels, and what the app repairs

The page gives up the video id, title, channel, thumbnail and duration. It does
**not** give up view counts or publish dates, and it truncates every title to 100
characters with no full copy anywhere in the payload.

So the app tops those up — from its own `videos` table first, then from its stats
lookup — filling gaps without overwriting. The title is the exception: the app's
answer always wins, because the app stores the title in *your* language
(`hl=zh-TW`) while the page gives whatever language the browser was in. Those
are different strings, not a long and a short version of one, so preferring the
longer would put an English title on a card next to the Chinese one the feed
shows for the same video.

The list goes to `POST /api/playlists/import-external`, which needs no YouTube
token: that's what makes this work for every account here. Whose playlist it
becomes is decided by the API key the worker attaches, like everything else.
Re-importing the same playlist re-syncs the copy you have rather than making a
second, and nothing is ever removed from it.

## Clean embed

The app already passes `controls=0` to every embed. That turns off the control
*bar* and nothing else — the channel avatar and title stay across the top, the
"Includes paid promotion" badge with them, a play/pause button sits in the
middle, and a share / watch-later / "More videos" / watch-on-YouTube row runs
along the bottom. The embed API has no switch for any of it; `modestbranding`
and `showinfo` were the old ones and both are dead.

Nothing in a web page can reach inside a cross-origin iframe to remove them.
A content script can, so `embed.css` is one.

## Settings: the app's address, and who you are

**Normally you set neither.** Open the app once and the extension takes both from
the page — see "How it knows who you are" below. The options page
(`chrome://extensions` → **Details** → **Extension options**) is the fallback,
and stores them together under one key in `chrome.storage.local`.

**App address** — where the app is served, `http://localhost:5173` by default.
It has to stay on `localhost` or `127.0.0.1`: those are the extension's
`host_permissions`, and a fetch outside them is blocked whatever this says. Any
*port* on those hosts is fine.

**API key** — usually filled in for you; the app's **Settings → Extension** has
it if you need to paste it. It says *whose* app this is: whose history a video
you watch on youtube.com is recorded in, whose Watch Later the save button
reaches, whose channel list the tick is drawn from. Treat it like a password.

Leave the key empty and the app still answers, as long as it holds exactly one
account — which keeps a single-person install working with nothing configured.
Once there are two accounts an unkeyed request has no answer, and the buttons
report the refusal rather than guessing.

Saving checks the pair against `/api/auth/me` and tells you who it reached. A
typo'd key would otherwise fail silently, and the first you'd know is your watch
history quietly not being recorded.

Changing either value drops every cached list, in **both** layers — the memory
copy and the `chrome.storage.local` one. The stored copy is what a fetch falls
back to when the app is unreachable, so leaving it would show the previous
person's Watch Later ticks to the next.

### How it knows who you are

`marker.js` runs on the app's own pages, and that is the one place in this
extension where a request to the API is **same-origin** — so it carries the
session cookie, and `/api/auth/api-key` simply answers. It forwards the key and
the origin to the worker, which stores them like any other configuration. Open
the app, and the extension belongs to whoever the app says you are.

Nothing else here can do that. The service worker's requests come from the
extension's own origin; the content script on youtube.com is a different site
again. Both get a request without the cookie — which is exactly why the key
needed carrying across by hand before this.

The newest answer wins, so a shared browser profile follows whoever opened the
app last — the same answer the app itself would give that browser. Changing
identity drops every cached list, in both layers (see below).

It only reaches origins the extension has permission for: `localhost` and
`127.0.0.1`. An app opened at `192.168.1.50:5173` is outside that, and the
options page is what covers it.

### Why a key and not the session cookie

The app in a browser signs in with Google and gets a cookie. The extension
can't use it: its worker posts on behalf of a `youtube.com` page, so the cookie
would need `SameSite=None`, which requires `Secure`, which requires HTTPS —
a certificate to talk to `http://localhost`. A bearer token has none of that.

The worker owns both values, and `open-in-app.js` asks it for the address rather
than keeping its own copy. It used to be a constant in both files: change one and
the button opens the wrong port while saving still works, which reads as a
baffling bug.

## Install

It's unpacked and unbuilt — seven files, no toolchain.

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select this `extension/` directory
4. Open its **Extension options** and paste your API key
5. Reload the app

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
