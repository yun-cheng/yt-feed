# Frontend — YT Feed

A single-page React app that renders the ranked feed, channel/playlist pages,
search, and downloads. Its signature feature is the **hover preview**: hovering a
card plays the real YouTube video (muted) inline with custom captions and
scrubbing.

---

## Stack

| Concern | Choice |
|---|---|
| UI | **React 19** + **TypeScript** |
| Build/dev | **Vite 6** (`@vitejs/plugin-react`) |
| Styling | **Tailwind CSS v4** (via `@tailwindcss/vite`, no config file) |
| Video preview | **YouTube IFrame Player API** (loaded on demand) |
| Tests | **Vitest** + **Testing Library** (jsdom) |
| Routing | none — hand-rolled on the **History API** (see below) |

Dependencies: [`package.json`](package.json).

---

## Run

```bash
cd frontend
npm install
npm run dev        # Vite dev server on :5173
```

The dev server proxies `/api` → `http://localhost:8000` (see
[`vite.config.ts`](vite.config.ts)), so the backend must be running for data.

```bash
npm run build      # tsc typecheck, then vite build → dist/
npm run preview    # serve the production build
npm test           # vitest run
```

---

## How it's built

### Entry

`main.tsx` mounts `<App/>` inside an `ErrorBoundary` and `StrictMode`, and pulls
in `index.css` (Tailwind + a few custom keyframes/utilities).

### `App.tsx` is the hub

There is **no router library**. `App.tsx` holds essentially all page state and
does client-side routing itself:

- A `Page` union — `'feed' | 'channel' | 'channels' | 'playlist' | 'playlists' |
  'downloads' | 'search' | 'watchlater'`. Note there is deliberately **no
  `'watch'`** — `/watch/:id` is an overlay, not a page (see below).
- On navigation it calls `history.pushState` with a URL built by `buildPath(...)`;
  a `popstate` listener parses the URL back into state, so **back/forward work**
  and every view is deep-linkable.
- Feed controls (time window, sort, selected tags, videos↔shorts mode) are
  encoded in the URL query string and restored on load — so a filtered feed can
  be bookmarked.
- Data is fetched from `/api/*` into React state (`fetchFeed`, `fetchTags`, …);
  the feed is paged by `offset`/`limit` with a load-more trigger (`loadMoreFeed`).
  Every call goes through `apiFetch` (`lib/api.ts`) — a drop-in `fetch` wrapper
  that shows an error toast on a failed request, so nothing fails silently.
  High-frequency background calls (hover captions/storyboards, the topic-build
  poll) opt out with `{ quiet: true }`.

### Auto-refresh

A visibility-aware timer periodically **re-reads** the feed (`fetchFeed` +
`fetchTags`) to pick up whatever the backend's scheduler last scraped — a plain
data refresh, no scraping on the client.

### Components

```
components/
  Sidebar.tsx / TopBar.tsx        chrome: nav, search box, tag filters
                                  (on a channel page the sidebar swaps the
                                  global taxonomy for that channel's topic chips)
  TimeSortControls.tsx            time-window + sort pills
  VideoCard.tsx                   the card + hover preview (the complex one)
  VideoRow.tsx                    list-row variant
  ChannelPage.tsx / ChannelsPage.tsx
  ChannelTags.tsx                 per-channel label editor (apply/remove/suggest)
  PlaylistPage.tsx / PlaylistsPage.tsx / SaveToPlaylist.tsx
  DownloadsPage.tsx
  SearchPage.tsx
  WatchPage.tsx                   in-app player (/watch/:id) — full-size embed,
                                  keyboard controls, our own captions, metadata,
                                  description, topic chips
  Toaster.tsx                     the app's single error-toast surface
hooks/
  audioStore.ts                   shared, persisted preview VOLUME
  toastStore.ts                   tiny global toast store (API errors)
lib/
  api.ts                          apiFetch — fetch wrapper that surfaces failures
```

---

## The hover preview (`VideoCard.tsx`)

The most intricate component. When a card is hovered it lazily creates a
YouTube IFrame player over the thumbnail and drives it directly:

- **Always starts muted.** Muted autoplay is the only kind browsers reliably
  allow — an unmuted autoplay without a fresh gesture just wedges buffering.
- **Click the video to unmute** *that* preview. A real click is the gesture the
  autoplay policy requires, so unmuting an already-playing muted video is
  reliable (no spinner/wedge). Clicking before it has loaded arms the unmute so
  it applies the moment playback starts (a second click while still loading
  opens it instead, so a slow preview can't trap you). Once unmuted, a further
  click **opens the watch overlay**. Buttons, the progress bar, the title, and
  the ⋮ menu keep their own behavior and never unmute-or-open.
  Modifier/middle-clicks open YouTube in a new tab natively.
- **Mute is per-video**; only **volume** is shared and persisted, via
  `hooks/audioStore.ts` (a tiny `useSyncExternalStore`).
- The thumbnail is held over the player until real frames render (avoids a blank
  card during the ~1–2s embed load), with a dim-to-black loading cue.
- Captions are **rendered by us** from the `/api/feed/captions` transcript (not
  YouTube's embed captions), and the scrub bar uses `/api/feed/storyboard`
  frames. Idle players are torn down shortly after the cursor leaves so audio
  can't linger.
- **Downloaded videos** (the Downloads page) play the **local file** in the same
  card via a `<video>` element behind the same player interface (`localSrc` /
  `localOnly`), so they preview and scrub fully offline.
- **Shorts** render as portrait (9:16) cards; a sidebar toggle switches the feed
  and channel pages between long-form videos and Shorts.
- **Keyboard while hovering**: `m` toggles mute, `c` toggles captions.

> If you change the mute/preview logic, read the comments in `VideoCard.tsx`
> first — most of them document a specific browser autoplay-policy constraint
> that was found the hard way.

---

## The watch overlay (`WatchPage.tsx`)

Opening a video plays it in-app at `/watch/:id`: a full-bleed YouTube embed with
page-level keyboard controls and our own captions, plus title / channel / stats /
description below.

**It's an overlay, not a page.** It renders outside the page switch as a
`fixed inset-0` layer above everything, so the page you came from stays mounted
underneath with its **scroll position and loaded videos intact**. Browser back
just removes the overlay and you're exactly where you were — on any page, with
no refetch. That's why `Page` has no `'watch'`: `selectedVideoId` drives the
overlay and the underlying `page` is never touched when opening or closing it.
`popstate` distinguishes three cases — open overlay / close overlay (leave the
page alone) / real page navigation — and `syncUrl` leaves the `/watch` URL alone
while it's open.

Other details:

- **Volume is shared with previews** both ways: the store's volume is applied on
  ready, live changes follow, and using the embed's own volume control mirrors
  back to the store.
- **Autoplay**: unmuted when a page gesture allows it (so it plays with sound
  immediately), muted otherwise (e.g. a cold-loaded `/watch` link). A *blocked*
  unmuted autoplay doesn't error — it wedges on a buffering spinner — so a
  watchdog notices playback never started within ~4s and rebuilds the player
  muted, which always plays.
- **Metadata**: renders instantly from the clicked card's `VideoItem`, then
  enriches from `/api/feed/video/:id` (the only source on a cold load).
- **Description**: its own fetch from `/api/feed/description/:id` (the backend
  scrapes it on demand and never stores it), in a separate effect so a slow
  fetch can't hold up the title and stats. Collapsed to four lines with a
  `...more` toggle that appears only when the text really overflows. Clicking
  the collapsed box expands it, the way YouTube does; collapsing is the button's
  job alone, so a stray click while reading can't shut it. Links are clickable
  and stop propagation, and a click that ends a text selection counts as a drag.
- **Keyboard**: a single window-level handler drives the player through the
  IFrame API, so shortcuts work wherever focus is on the page — not only while
  the iframe holds focus. `space`/`k` play-pause, `m` mute, `f` fullscreen (of
  our box, so overlays and shortcuts survive it), `←`/`→` ±5s, `j`/`l` ±10s,
  `↑`/`↓` volume (the embed doesn't map these itself), `c` captions. We focus our
  box, not the iframe, and pull focus back whenever a click lands in the video —
  a cross-origin iframe otherwise swallows its own keys. A brief volume HUD shows
  while adjusting.
- **Captions**: rendered by us from the `/api/feed/captions` transcript (the
  embed's own captions can't be positioned or styled). The style is cloned from
  youtube.com's player (measured): per-line `rgba(8,8,8,.75)` box, weight 400,
  grayscale smoothing, size scaled to the player via container queries. Auto
  tracks reveal word-by-word from the per-word timing and roll two lines
  (overlapping cues), pinned left so words don't shift; manual subs appear whole,
  centered, full-width. Positioned above the control bar on any player size.
- Non-embeddable videos (`onError` 101/150) show an "Open on YouTube" fallback.

> **Trap:** the hover preview must be destroyed *before* the watch player is
> created. Both are YouTube players for the same video, and two live players for
> one video wedge the new one on a buffering spinner (unmuted icon, no sound).
> `VideoCard.openVideo()` therefore calls `teardownPlayer()` synchronously rather
> than pausing and letting the ~600ms idle timer clean up. This looked exactly
> like an autoplay-policy bug and wasn't.

---

## Tests

Component/behavior tests live in `src/test/` and run under Vitest + jsdom
(`npm test`). `src/test/setup.ts` wires up `@testing-library/jest-dom`.
