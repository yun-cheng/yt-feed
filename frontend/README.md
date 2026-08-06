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
  'downloads' | 'search' | 'watchlater' | 'imported' | 'history' | 'local' |
  'localfolder'`. Note there is deliberately
  **no `'watch'`** — `/watch/:id` is an overlay, not a page (see below), and
  `/local/:folderId/:videoId` is the same arrangement over a folder page.
- On navigation it calls `history.pushState` with a URL built by `buildPath(...)`;
  a `popstate` listener parses the URL back into state, so **back/forward work**
  and every view is deep-linkable.
- **Every filter and sort is in the URL**, so a refresh — or a pasted link —
  restores the exact view: `tags`, `age`, `sort`, `shorts`,
  `watch`, `label` (a channel's topic chip), `hidden` (show hidden channels),
  and `q` (search). See "URL state" below.
- Data is fetched from `/api/*` into React state (`fetchFeed`, `fetchTags`, …);
  the feed is paged by `offset`/`limit` with a load-more trigger (`loadMoreFeed`).
  Every call goes through `apiFetch` (`lib/api.ts`) — a drop-in `fetch` wrapper
  that shows an error toast on a failed request, so nothing fails silently.
  High-frequency background calls (hover captions/storyboards, the topic-build
  poll) opt out with `{ quiet: true }`.

### URL state

Pages keep **separate** sort / window / watch-status state — a channel page's
sort isn't the feed's — but the URL carries **one** `sort`, `age` and `watch`.
The page being shown owns them; every other page's copy sits at its own default. `PAGE_DEFAULTS` is that table, and the `USES_*` sets say
which controls a page actually has, so a param a page can't change is never
written.

Those same sets feed `pageFilters(page)`, which is what the **sidebar** renders
from — so a filter is either usable *and* in the URL, or in neither:

| page | Videos/Shorts | watch status | tags | topics | show hidden |
|---|---|---|---|---|---|
| feed | ✓ | ✓ | ✓ | | ✓ |
| channel | ✓ | ✓ | | ✓ | |
| history | ✓ | ✓ | ✓ | | |
| watchlater | | ✓ | ✓ | | |
| imported | | ✓ | | | |
| channels | | | ✓ | | |
| downloads / playlists / search / local | | | | | |

The reasoning: tags live on **channels**, so they can't filter a page of videos
from channels you don't follow (imported), and a channel page swaps them for
that channel's own topics. Watch status needs a list of videos, which the
channels page isn't. Videos↔Shorts needs a list that's actually split that way.
Downloads, Playlists and Search do no sidebar filtering at all, so their filter
panel is empty.

- **Values equal to the page's default are omitted**, so ordinary URLs stay
  short — and the same value can be worth writing on one page and not another
  (`age=0-3` is the feed's default but not a channel's, whose default is `0-30`).
- `buildPath(state)` takes an object, not a positional list — there are ten
  fields now, and it's the one place that knows what a page's URL looks like.
- `stateFromUrl()` is the inverse, and is used by **both** the cold load and
  `popstate`, so the two can't drift apart.
- **Navigations only name their page.** `setPage` / `selectChannel` push the
  bare path; the `syncUrl` effect then `replaceState`s the full query once the
  state has settled. Nothing else has to know the param list.
- Filters that reset on a fresh visit (a channel's watch status and topic label,
  History's watch status) are cleared **by the navigation**, not by an effect on
  `[page]`/`[channelId]` — an effect would also fire on a cold load and wipe the
  very value the URL just restored. A reload isn't a fresh visit.

### Watch history

Every video remembers where you stopped. `WatchPage` reports its position every
10s while the player is actually PLAYING, and once more on the way out — through
the effect cleanup, with `keepalive` so the last report survives the page being
torn down. Reopening the video seeks straight back there.

The pieces that aren't obvious:

- **Two things race on open** — the saved position and the player itself, either
  can land first. `resumeAt` stays `null` until the fetch answers (so "not loaded
  yet" is distinct from "start at 0"), and a short poll does the seek as soon as
  both exist. The player's `onReady` fires inside the creation effect, before the
  position may have arrived, so it can't own this.
- **A finished video restarts.** Resuming within `RESUME_TAIL_SEC` of the end
  would drop you onto the credits, so that case seeks to 0 instead.
- **The card's bar is `watchProgress`, not `progress`** — `VideoCard` already
  uses `progress` for the hover preview's own playhead. The bar renders only
  while the card is idle; hovering hands that strip to the preview's scrubber.
  It always fills to the CURRENT position, never to `watched`: you rewatch
  things, and a bar stuck full from the first time round would tell you nothing
  about where you are in the rewatch. `watched` only fills it as a fallback when
  the duration is unknown and there's no ratio to compute.
- **A finished video gets a "Watched" badge** top-left, since the bar alone
  can't say it: a rewatch pulls the bar back to wherever you are now, and a
  video abandoned at 95% looks identical to one seen through. Idle-only, like
  the bar.
- **The page obeys the global controls**, like the feed does: the Videos/Shorts
  toggle and the sidebar's tag selection, plus its own watch-status selection
  (see below). Both are applied
  client-side in `App` (`visibleHistory`) since the list is already loaded, and
  the tag rule — OR within a group, AND across groups — is the exported
  `filterByTags`, shared with Watch Later so a filtered library can't disagree
  with a filtered feed. `HistoryPage` takes the filtered list plus `totalCount`,
  which is what tells "nothing watched yet" from "nothing matches".
- **`App` holds one `progressById` map** built from the history list and passed
  to every grid, rather than each page fetching its own. It refetches whenever
  the watch overlay closes, which is exactly when a position has changed — that's
  what makes the card behind the overlay show its new bar immediately.

### The watch-status filter

A sidebar section — unwatched / in progress / watched — derived from watch
history rather than stored: no entry means never opened, an entry means started,
an entry with `watched` means finished. **Watched is off by default**: the home
feed is for finding something to watch, and things you've already seen are noise
there.

- It is carried in the URL as `watch=` like every other filter, and **also**
  mirrored to localStorage — that's the fallback for a cold load with no `watch`
  param, so your last choice is remembered when you just open the app.
  `watch=none` is an explicit "no filter"; an absent param means "use the
  page's default", and the two aren't the same.
- The **feed and a channel page apply it server-side** (`watch=` on
  `/api/tags/feed` and `/api/channels/{id}/videos`) so `total` and the paging stay
  honest. Watch Later, Imported and History are already-loaded lists, so they use
  `filterByWatchStatus` on the client.
- **Watch Later and Imported share the global selection**; History and a channel
  page each keep their own (see below).
- Selecting **every** status — or **none** — means "don't filter", matching both
  the tag filter and the backend, so an empty selection can't leave you staring
  at a blank page.
- **A channel page gets its own selection too**, cleared each time you open a
  channel — you open one to see what it has, not what's left of it, and one
  channel's filter shouldn't follow you to the next. The sidebar swaps the global taxonomy for that
  channel's topic chips there, but the watch-status section stays.
- **History gets its own selection**, not the global one — which hides watched
  videos, backwards on a page whose whole job is listing what you've watched.
  `unwatched` can't match anything there either, so that chip isn't offered. The
  selection starts **empty** (no filter) and is reset to empty by every
  navigation to the page, so it always opens showing everything and a filter you
  set last time can't ambush you — but a reload of a `?watch=` URL keeps it, a
  refresh being a continuation rather than a fresh visit. Toggling it there
  leaves the feed's selection alone, and vice versa.

### The time window

`TimeRangeSlider.tsx` is a two-handled slider over a fixed ladder of day
boundaries, and `lib/timeWindow.ts` is the model both it and the URL agree on:

```
days:    0     1     3     7    14    30    90   180   365
label:  now   1d    3d    1w    2w    1m    3m    6m    1y
index:   0     1     2     3     4     5     6     7     8
```

A window is a `TimeRange` — a `{lo, hi}` pair of **indices** — which the wire
format spells in days: `?age=3-14`. Indices are what the slider moves in and
what keeps the short windows reachable, since the ladder is spaced by index
rather than by days; 1d and 1y are one notch apart either way.

This replaced eight preset buttons plus a narrow/wide toggle. Those could only
reach ranges anchored at 0 ("wide") or exactly one notch wide ("narrow") — 15 of
the 36 pairs the ladder allows. Naming both edges reaches all of them, and the
toggle disappears into the question "is `lo` at 0?". `rangeFromLegacy()` reads
the old `window` + `time_mode` params so existing bookmarks still resolve; the
first `syncUrl` then rewrites them to `age`.

Three ways to set it, and the third is why the button row isn't missed:

- **Drag a thumb** — move one edge.
- **Keyboard** — Radix gives the thumbs arrow keys and ARIA for free.
  `minStepsBetweenThumbs={1}` (backed by `clampRange`) keeps the band from
  collapsing to a window that selects nothing.
- **Click a tick label** — sets the older edge, keeping the recent one when it
  still fits. That's the one-click "just show me the past week" move.

The track is notched at every interior tick, cut in the page colour so the
notches read over the filled range and the empty track alike. The ends are the
track's own edges and need none. `now` is the origin, never an older edge, so
it's a marker rather than a button.

Radix's slider is the one third-party UI component in the app. It was worth it
for the keyboard and ARIA handling; what it does **not** do is drag the filled
band as a unit to sweep a fixed-width window through time. That was cut, and
it's purely additive on top of the same controlled value if it's ever wanted.

### The Imported page

`/imported` lists videos added by pasting a link (`ImportedPage.tsx`), rendered
by the **same `VideoRow`** the home feed uses — so the cards, the hover preview
and every action (watch, download, save to playlist, watch later) are identical;
only the source of the list differs. `ImportDialog.tsx` is the paste modal, and
the TopBar grows an **Import** button at the top right on this page only.

Three deliberate differences from the feed:

- **No time window.** An import is an explicit pick, not a stream of new
  uploads, so filtering it by publish date would hide most of what you just
  added. It gets its own sort (`recentSortOptions('Added')`) defaulting to
  `recent` — import order, which is what the API already returns.
- **Its own remove action.** The card menu shows "Remove from imported"
  (`onRemoveImported`), alongside the existing playlist/download variants.
- **The watch status is its only sidebar filter.** Tags are attached to
  channels, and these videos come from channels you don't follow, so no tag
  could ever match one; and it's a single flat list, so there's no Videos↔Shorts
  split either.

### Local folders

`/local` lists directories on the **backend's** machine (`LocalPage.tsx`);
`/local/:id` is one folder's videos (`LocalFolderPage.tsx`); `/local/:id/:videoId`
plays one (`LocalWatchPage.tsx`), as an overlay over the grid — the same
arrangement `/watch/:id` has over the feed.

The path is **typed, not picked**. A browser file picker hands back a sandboxed
handle, and the process that has to open the directory is the backend, which may
not even be on this machine. What it needs is a path in its own filesystem.

A local video is deliberately **not a `VideoItem`** (`lib/local.ts` has its own
types): it has no channel, no stats and no `youtube_id`, and dressing it as one
would push it through the embed, watch history and playlists, none of which have
anything to work with. So `LocalFolderPage` has its own card — same shape as the
feed's (thumbnail, duration badge, resume bar, play-on-hover) so the two feeds
feel like one app, without VideoCard's channel/YouTube machinery.

What IS shared is the player: `LocalControls.tsx` (extracted from `WatchPage`,
along with `localPlayer()` and the `PlayerApi` type) is the same control bar a
downloaded video plays in — so the scrub preview, the shared volume and the
shortcuts behave identically whichever kind of local file you're watching.

Two things the folder page does that the other libraries don't:

- **It polls while `scanning`.** Durations are measured backend-side by ffprobe,
  which on a cloud-synced drive streams the whole file down; the listing returns
  first and durations fill in (see the backend README's "Local folders").
- **Hovering only starts a preview after 400ms**, and opening a video clears it.
  Each preview is a real range request against a file that may be streaming from
  the cloud, so sweeping the grid mustn't start twenty of them — and one left
  running behind the overlay would hold a second stream of the very file the
  player is reading.

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
  TimeSortControls.tsx            the time-window slider + sort pills
  TimeRangeSlider.tsx             two-handled window picker (see "The time window")
  VideoCard.tsx                   the card + hover preview (the complex one)
  VideoRow.tsx                    list-row variant
  ChannelPage.tsx / ChannelsPage.tsx
  ChannelTags.tsx                 per-channel label editor (apply/remove/suggest)
  PlaylistPage.tsx / PlaylistsPage.tsx / SaveToPlaylist.tsx
  DownloadsPage.tsx               the offline library — cards open the watch
                                  overlay, which plays the file from disk
  ImportedPage.tsx                videos added by URL — the same VideoRow the
                                  feed uses, so cards and actions are identical
  ImportDialog.tsx                the paste-links modal (opened from TopBar)
  HistoryPage.tsx                 what you've watched, same VideoRow again
  LocalPage.tsx                   local folders: the list, and the add-by-path box
  LocalFolderPage.tsx             one folder's video files, as its own card grid
  LocalWatchPage.tsx              player for a local file (/local/:id/:videoId)
  LocalControls.tsx               our control bar + the <video>→PlayerApi adapter.
                                  Drives a file on disk, and the embed too when
                                  the clean-embed extension is installed
  PlayerMarks.tsx                 bookmarks (`b`) and the A–B repeat loop
                                  (`[`, `]`, `\`): state, shortcuts, and the
                                  marks drawn on the progress bar (ours, or a
                                  rail over the embed's)
  SearchPage.tsx
  WatchPage.tsx                   in-app player (/watch/:id) — the embed, or the
                                  downloaded file with our own control bar;
                                  keyboard controls, our own captions (language
                                  switcher, dual subtitles, AI translation),
                                  metadata, description, topic chips
  Toaster.tsx                     the app's single error-toast surface
hooks/
  audioStore.ts                   shared, persisted preview VOLUME
  toastStore.ts                   tiny global toast store (API errors)
lib/
  api.ts                          apiFetch — fetch wrapper that surfaces failures
  ext.ts                          is the clean-embed extension installed?
  quality.ts                      YouTube's quality names → "1080p"
  local.ts                        local-folder types + fetch helpers
  storyboard.ts                   YouTube's scrub sprite sheets → one frame
  time.ts                         formatTime — the player clock
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

Opening a video plays it in-app at `/watch/:id`: a full-bleed player with
page-level keyboard controls and our own captions, plus title / channel / stats /
description below. The player is the YouTube embed, or — if the video has been
downloaded — the file on disk (see [Downloaded videos](#downloaded-videos-play-from-disk)).

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
  `↑`/`↓` volume (the embed doesn't map these itself), `c` captions, and the
  marks below (`b`, `[`, `]`, `\`). We focus our
  box, not the iframe, and pull focus back whenever a click lands in the video —
  a cross-origin iframe otherwise swallows its own keys. A brief volume HUD shows
  while adjusting.
- **Bookmarks and A–B repeat** (`PlayerMarks.tsx`): `b` marks the moment, `[` and
  `]` set the loop's ends, `\` clears it. Both drive the player through
  `PlayerApi`, so they behave the same over the embed and over a file on disk.
  - **Bookmarks persist** (`/api/bookmarks`, keyed by the video id — YouTube's or
    a local one). Pressing `b` within 2s of an existing mark **removes** it, so a
    second press undoes the first; the list is already in hand, so that decision
    needs no round-trip. A new mark renders immediately under a temporary id and
    swaps in the saved row — a mark that appears a beat after the keypress reads
    as a dropped one.
  - **The loop is session state**, cleared when the video changes: it's about
    this sitting, not the video. Either end can be set first and either can be
    moved afterwards; the loop simply stays inactive until the pair makes sense
    (B after A, ≥0.5s apart), so neither key is ever a press that does nothing.
    A 200ms timer of its own sends the play head back to A at B — the caption
    tick can't do it, since that only exists while captions are on. A loop ending
    at the very end of the video hits B as the video ENDS, which leaves a seek
    paused, so the tick nudges it back into play.
  - **Both are drawn on the progress bar** (`MarkTrack`) — bookmarks as white
    ticks, the loop as a yellow span with end caps, all solid and dark-ringed so
    they read against whatever frame is behind them. That's the axis they're
    positions on; anywhere else and you have to translate a timestamp back into a
    place in the video. The **span appears only once the loop is really
    running**; a half-set loop shows just its end cap, since a colour bar over
    the rest of the video would claim something repeats when nothing does.
  - **Every mark is clickable** and jumps to itself — on our own bar that beats
    the bar's own click, which would only land near the mark (the press stops
    propagating, so the bar doesn't also treat it as a scrub). Each tick sits in
    a wider invisible hit area, since 3px is not a target.
  - **Over the embed** the bar is inside the iframe, so `EmbedMarkRail` lays the
    same marks over it, at a **constant** distance up from the player's bottom
    (76px — measured at 73px on a 560px-wide player, 74 at 800, ~78 at 1280). It
    was a share of the height first, which drifted further out the bigger the
    window got: 10% of a 1080px-tall player is 108px, half a control bar too
    high. Its marks are the only pixels that take the pointer, and they sit on
    YouTube's scrubber: swallowing a click meant for it is the price of being
    able to click a mark at all, paid at the handful of x positions you put one
    on.
  - Each keypress also leaves a brief line saying what it did; a shortcut you
    can't tell fired is one you stop trusting, and the chrome is often hidden.

- **Our chrome fades like a player's** (`chromeAwake`): the control bar over a
  local file, and the caption button, pin and mark rail over the embed, are up
  while the pointer is on the player *and moving*, and whenever playback isn't
  running — a paused player keeps its controls, and buffering counts as running
  so a stall doesn't raise them and drop them again. Playing state comes from the
  1s volume poll, which already asks; no second timer. An open caption menu pins
  the chrome, since a button fading out from under its own menu would be absurd.
  - The **stillness** half is what makes fullscreen work. Leaving the player was
    the only signal at first, which is no signal at all in fullscreen: the player
    is the whole screen, the pointer never leaves it, and the chrome sat there
    forever against a video whose own controls had long since gone.
  - Stillness is measured from the last mouse move over the player, or shortcut
    key pressed. Over a local file every move reaches us already. A cross-origin
    iframe keeps its own mouse events, so over the **embed** a sheet (`absolute
    inset-0 z-10`) is laid over the video for exactly as long as the chrome is
    down, to catch that first movement — without it, moving the pointer brought
    YouTube's controls back and left ours hidden, and in fullscreen nothing
    brought them back at all.
  - The sheet unmounts the moment it wakes anything, so it can only ever swallow
    one gesture, and when that gesture is a click we do what the click was going
    to do anyway: play/pause, through the same `PlayerApi`. One case escapes — a
    double-click begun while the chrome was down toggles play instead of leaving
    fullscreen, because the second click lands after the sheet is gone. `f` and
    Esc still do it.
  - A mousemove also *sets* "pointer is over the player", not just the activity
    stamp: entering fullscreen by keyboard makes the player the whole screen
    without the pointer ever crossing its edge, so `mouseenter` never fires.
- **Our own controls over the embed** — `EMBED_OWN_CONTROLS` at the top of
  `WatchPage.tsx`, now `hasCleanEmbed()` (`lib/ext.ts`) rather than a constant.
  It passes `controls: 0` to the embed and renders `LocalControls` against
  `playerRef` instead, so one bar serves both sources: the marks go on a track we
  own (no rail, no measured offset), and the fade can't drift out of step with
  controls that no longer exist — the sheet can simply stay, seeing every move.
  - **It needs the extension** (`extension/` at the repo root). `controls: 0`
    removes only the control *bar*; the channel avatar and title on top, and the
    share / "More videos" / watch-on-YouTube row along the bottom, have no switch
    (`modestbranding` and `showinfo` are both dead). Nothing in a page can reach
    into a cross-origin iframe to remove them — a content script can, so that's
    what the extension is. Without it, YouTube's chrome would sit *over* our bar,
    so we keep YouTube's controls and lay the marks on its rail instead.
  - The capability is read **once at module scope**, deliberately: `controls` is
    a playerVar baked into the iframe URL at construction, so it has to be
    settled before the first player is built and must not change under one.
    Install or remove the extension, then reload.
  - YouTube's quality / speed / subtitle menus go with its bar. Our captions are
    unaffected. The bar shows the **resolution** it settled on (see below), but
    can't change it.
  - The scrub preview keeps its frames, from a different source. A file on disk
    is seeked directly; the embed's frames aren't ours to seek, so YouTube's
    **storyboard** sprite sheets stand in — the same `/api/feed/storyboard` the
    cards use, scaled to the popup's width so the two look identical. A video
    with no storyboards falls back to the timestamp alone.
- **Captions**: rendered by us from the `/api/feed/captions` transcript (the
  embed's own captions can't be positioned or styled). The style is cloned from
  youtube.com's player (measured): per-line `rgba(8,8,8,.75)` box, weight 400,
  grayscale smoothing, size scaled to the player via container queries. Auto
  tracks reveal word-by-word from the per-word timing and roll two lines
  (overlapping cues), pinned left so words don't shift; manual subs appear whole,
  centered, full-width. Positioned above the control bar on any player size.
- **Caption menu (two columns)**: a CC button sits in the player's bottom-left row,
  as a third button next to the embed's built-in share / watch-later, and opens a
  **two-column** picker — **Main** | **Second**. Each column lists every language
  this video actually **provides** among English / 中文 / 日本語 / 한국어
  (`/api/feed/caption-langs`) — uploaded subs or the original ASR track, not
  YouTube's on-the-fly auto-translations — plus the AI translation (below). There's
  no "Off" row: an empty slot **is** off, and clicking the active row toggles it off
  (the `c` shortcut still hides everything). A saved language is only honoured on a
  video that actually offers it (`effCaptionLang`) — otherwise the backend hands back
  a machine *translation* of another track, which once surfaced as a Japanese
  transcript on a video with no Japanese captions. The pref is kept for the next
  video that does have it.
- **Main + Second (dual subtitles)**: the two slots overlay two tracks stacked in the
  player — e.g. original + translation for language learning. The **Main** track is
  always the primary (top) line; the **Second** sits beneath it (the *slot*, not the
  content, decides the order). Both share one renderer (`CaptionBlock`), and the menu
  stays open so both can be set in one pass. A slot can't hold the same track as the
  other, and there's never a Second without a Main, so the picks stay consistent
  (`setSlots`): toggling the Main off promotes the Second up; picking the Second's
  language as Main clears the Second; picking the Main's language as Second swaps the
  two.
- **AI translate**: a **Chinese** row (with an "AI" badge) in either column, offered
  whenever the source track isn't already Chinese. Unlike a real track it can fill
  **either slot** — as Main it shows the translation alone (the source track is still
  fetched, to translate *from*, but not displayed); as Second it rides under whatever
  Main shows. It comes from `/api/feed/captions-translate` — the source track run
  through an LLM into Traditional Chinese — and streams **as playback approaches,
  like video buffering**: a run of sentences is fetched when the translated span
  doesn't reach `AI_LOOKAHEAD_SEC` past the play head, so the first lines land in
  seconds regardless of video length and a stretch nobody watches is never translated
  (or paid for). A seek needs no special case — it lands somewhere uncovered and the
  same check fetches *there* instead of restarting at 0:00.

  It arrives as whole **sentences** with the time span each covers, not per-cue text,
  because a cue's mid-clause split point doesn't survive translation (see the
  backend's `_to_sentences`) — so it renders one complete sentence at a time against a
  source that may still be rolling word-by-word. The row shows "翻譯中…" while a
  request is in flight.

  It is **never restored from saved prefs** in either slot — unlike the other caption
  settings it's an explicit per-video opt-in, because auto-firing it would spend
  tokens and latency on every video you open without asking.
- **Word-by-word vs whole sentences**: a word-segment track (auto captions, per-word
  timing) shows as **two rows** in its column — the plain label renders whole
  **sentences**, and **"… (word-by-word)"** reveals words as they're spoken
  (left-aligned, following the per-word timing). Two rows rather than a nested toggle,
  so both display modes read as ordinary picks. `captionMode` is global — it drives
  whichever slot holds a word-segment track — so the split appears in **both** columns
  for any language known to carry per-word timing (accumulated in `wordSegLangs` as
  tracks load, so it stays available even when the track isn't the one displayed).
  Whole-cue tracks (manual / translated subs, word-less ASR) and the AI translation
  stay a single row — they're already whole lines, so word-by-word would do nothing.

  Whole-sentence mode stitches cues: `toSentences` flattens them to a word stream
  (sentence ends fall mid-cue) and breaks at `. ! ? 。 ！ ？`, centered, each shown
  until the next begins. A stitched sentence can run far past what's readable in one
  block (183 characters over 11s, in one measured case), so an over-long one is
  chunked to roughly two subtitle lines' worth (~84 Latin / ~36 CJK, since CJK is
  much denser).

  Pieces are sized **evenly**, not greedily filled to the cap. Greedy filling breaks
  at the last comma before the cap, which emits a runt whenever a sentence's only
  comma is near the start, and leaves a few stray words as the tail — on one video
  that produced 10 pieces under 25 characters (`'If you or I did that,'`,
  `'anything.'`, `'the tokens.'`). Instead `toSentences` decides up front how many
  pieces are needed and places each break nearest its ideal length, with a comma
  scoring a modest bonus rather than forcing the break. Same video: 0 runts.

  Chunking only happens here, for word-segment tracks, so every piece takes an
  **exact** start from its own token — no interpolation. Whole-cue tracks arrive
  pre-split by their author, and the AI translation is deliberately left whole
  (splitting it could only ever guess at timings, and whole sentences are what make
  the translation read well).
- **Transcript**: the caption track as readable prose, in its own panel beside the
  video's details. Opened from a "…" overflow menu next to Save (which also holds
  Download), and offered only when the video has captions. Each row is a whole
  **sentence** with its timestamp and seeks there on click — `toSentences(cues,
  false)`, i.e. the same stitching the caption block uses but with the
  display-width chunking off, since the panel has the width to hold a sentence and
  the chunked pieces read like broken prose.

  The row at the play head is highlighted and the panel **follows along**, but
  scrolls only its own box (`scrollIntoView` would drag the whole details column
  with it) and centres by measuring rects, not `offsetTop` — the row's
  `offsetParent` is an ancestor of the box, so `offsetTop` is in the wrong
  coordinate space. The jump is deliberately **instant**: a smooth scroll emits
  scroll events the whole way down, and for most of that trip the active row is
  off-screen, so the scroll-away detector below reads it as the reader moving and
  cancels the scroll it just started.

  Scrolling so the active row leaves the box stops the auto-scroll (nothing should
  fight a reader), and raises a floating **Sync to video** pill that re-centres and
  resumes. Because our own centering leaves the row centred, that check needs no
  flag to tell programmatic scrolls from real ones.

  A **globe** button in the panel header opens the languages the video provides
  (the `/caption-langs` list) plus an AI **Chinese** option, the same offer the
  caption menu makes. The transcript's track is **independent of the on-video captions** —
  reading along in one language while the video subtitles in another is the point —
  so picking a real language fetches that track into its own buffer, defaulting to
  the caption cues when they match (no extra request). The **AI transcript**
  differs from the AI captions in one way: it translates the *whole* video rather
  than staying ahead of the play head, since a transcript is read and searched end
  to end. It streams in batches (rendered as they land, `翻譯中…` while more is
  coming, a batch cap as a runaway guard), resumes from what's already translated
  on reopen rather than replaying from 0:00, and stops once the video is covered.

  **Search** filters the lines rather than merely marking them — the point is to
  find a moment and click into it — with the match highlighted in each surviving
  row. `Esc` clears the query (and on an empty field blurs, handing the keyboard
  back to the player); an `×` in the panel header closes it. Following stands down
  while searching.

  **Layout**: below `lg` the panel stacks under everything at a fixed height. At
  `lg` and up with the overlay pinned, the details pane stops scrolling as a whole
  and becomes a fixed-height two-column row: everything about the video on the
  left (title, stats, actions, description), the transcript full-height on the
  right, each scrolling independently. The width caps are **per panel**, not
  shared — the left prefers 650px and the transcript takes essentially all the
  spare room (up to 56rem), with any leftover falling back to the left so the row
  still fills the width.

  The position ticker that drives the caption reveal also feeds the transcript, at
  500ms instead of 120ms when only the transcript needs it: its highlight moves
  once a sentence, so the caption rate would be ~8 renders per useful change.
- **Persisted**: on/off, main + second language, and style are saved to
  localStorage (`ytfeed:caption-prefs`) and re-applied on the next video/session —
  the overlay seeds its state from them on mount. The AI-translate selection is
  deliberately excluded (see above).
- Non-embeddable videos (`onError` 101/150) show an "Open on YouTube" fallback.

### Downloaded videos play from disk

A video with a finished download plays from `/api/downloads/:id/file` instead of
the embed — no ads, no embedding restrictions, and it keeps working offline — and
still gets the whole page around it: title, description, transcript, history,
captions. That's also why the Downloads page has no player of its own; its cards
open this overlay like cards anywhere else.

Only the *player* differs. The rest of the component drives whatever is playing
through **`PlayerApi`**, the slice of the YouTube IFrame API everything here uses
(volume 0–100, state codes 0/1/2). `localPlayer(el)` wraps a `<video>` in that
same shape, so history reporting, the resume seek, the caption ticker, the shared
volume store and every keyboard shortcut work identically on either source.

**Choosing the source** happens once, when the downloads list is known, and is
never revisited:

- *Never revisited*, because swapping players mid-playback would drop the video
  back to 0:00. A download that finishes while you watch applies next time.
- *Wait for the list*, because it's fetched once at startup: on a cold load of
  `/watch/:id` it can still be in flight, and reading the empty list as "not
  downloaded" left downloaded videos playing from YouTube — intermittently, since
  opening from a page you were already on was always fine. `downloadsKnown` (set
  in the fetch's `finally`, so a failure still counts as an answer) gates the
  decision, and **neither** player is built until then — a frame of black beats
  the wrong player.
- Only `status === 'ready'` counts. A queued or failed download has a row but no
  file to serve, so those still use the embed.

**Our own control bar** replaces the browser's native one, which can't show a
scrub preview. It carries play/pause, mute + a volume slider (the shared,
persisted store, so a level set here follows you to the next video), the clock,
the CC button, pin and fullscreen — everything with a keyboard equivalent
(`k`, `m`, `f`). It shows while the pointer is over the player or while paused,
and mirrors the element's own events rather than polling, so a keyboard seek or
the resume jump moves it too.

The **scrub preview** is a second, hidden `<video>` of the same file seeked to the
hovered time — the trick `VideoCard` already uses for download cards. The file is
local and served with range support, so the exact frame paints instantly and no
storyboard fetch is involved (YouTube's sprite sheets are a workaround for *not*
having the file, and fetching them would defeat playing offline). The popup holds
its last position and timestamp while it fades out; reading the live values would
snap it to the middle showing `0:00` on the way out.

Over the **embed** there is no file to seek, so the same popup is filled from
YouTube's storyboards instead (`lib/storyboard.ts`): a few JPEGs, each a grid of
thumbnails, positioned by `background-position` with `background-size` set to the
whole sheet. Frame size differs per video, so the scale is derived from the
popup's width (`scaleToWidth`) rather than fixed — otherwise the two previews
would be different sizes. Tile and sheet dimensions are **rounded together**, or
each tile shows a sliver of its neighbour. `WatchPage` only fetches the sheets on
the path that can show them; hovering the card on the way in usually warmed the
same server-side cache already.

`PREVIEW_W` (240) is the **one** number that sizes all of this — the popup, the
local `<video>`, the storyboard scale, and how far the popup may travel before it
stops. It caps out around there because the storyboard does: sheets arrive at a
fixed tile size (320×180 is typical), and scaling past that only magnifies JPEG.
A file on disk has no such ceiling, but one number keeps both sources in the same
popup, which is worth more. The stop is `PREVIEW_W / 2` (it's centred on the
cursor) **plus the bar's 12px gutter**, so at either extreme the popup's edge
lands on the end of the track instead of flush in the corner of the video, which
reads as clipped.

**The bar's metrics are YouTube's**, measured off `.ytp-chrome-bottom` on the
desktop player at 1280x720 rather than guessed at:

| | value |
|---|---|
| button box | **48x40**, and **no gap between them** |
| icon glyph | 24px svg, ~18–22px of drawing |
| clock | **14px**, 8px padding |
| progress track | **6px** tall, **8px** clear of the buttons |
| side gutter | **12px** |

The one that isn't obvious is the gap: YouTube has **none**. The rhythm comes
from padding *inside* each wide button, which is why its row reads as roomy while
staying compact — and why the hit target is far larger than the glyph suggests.
Small buttons with gaps between them get both halves wrong.

The hover affordance is theirs too, read off the stylesheet rather than eyed:
`.ytp-right-controls .ytp-button::before` is a 48px pill at `border-radius: 40px`
filled with `rgba(255,255,255,.1)` — `rounded-full` + `bg-white/10` on a box this
shape. Not a small rounded rect, and not a circle (YouTube only goes circular
below its xsmall breakpoint).

`BAR_BUTTON` is that button, and **every button in the row uses it** — including
the ones `WatchPage` supplies (captions, pin, open-on-YouTube). The caption
button keeps only what is genuinely its own: the active underline, and, in its
floating placement over YouTube's chrome, a bespoke box that lines up with the
iframe's row instead of ours. Re-stating the numbers per button is how they
drift apart; that is what this constant exists to prevent.

The right-hand group is `[resolution] [YouTube] [pin] [fullscreen]`.

The **resolution label** leads it. A file on disk simply knows its own height;
the embed only has YouTube's name for the quality it settled on, so
`lib/quality.ts` translates ("large" is 480p, "medium" is 360p — nobody guesses
those). It's polled with the clock rather than read once, because on auto the
quality drifts with bandwidth. Names that mean "not yet" — `unknown` before
playback starts, `auto` before it settles, anything unrecognised — hide the label
rather than put a word where a number belongs.

It is **read-only, and has to be.** `setPlaybackQuality` still exists on the
player but has been a no-op for years (called with `hd1080`, the video stayed at
640x360 — measured, not assumed). The setter that does work,
`setPlaybackQualityRange`, is not proxied across the iframe boundary: it is
`undefined` on a parent-side player instance, which carries 72 other functions.
Only a script running *inside* the embed can reach it, so switching quality would
have to go through the extension.

Over the embed the label only appears with the extension installed, since it
lives in our bar and YouTube's own bar is used otherwise. Downloaded and local
files always have it.

**Open on YouTube** sits next to it and carries the moment across:
`watch?v=ID&t=115s`, read off the player at click time rather than tracked in
state — a value wanted once per click doesn't earn a subscription that re-renders
the page four times a second. It works over a downloaded file too, since the
position means the same thing in the copy on YouTube. Clicking **pauses** on the
way out: the overlay keeps playing behind the new tab otherwise, and two copies
of the same audio is a worse greeting than pressing play again.

Against the embed without the extension, three of these float over the player
instead — its control bar is inside the iframe, out of reach — so the caption
button, open-on-YouTube and the pin each render in two placements from one
definition (`captionControl` / `youtubeButton` / `pinButton`).

> **Trap:** the hover preview must be destroyed *before* the watch player is
> created. Both are YouTube players for the same video, and two live players for
> one video wedge the new one on a buffering spinner (unmuted icon, no sound).
> `VideoCard.openVideo()` therefore calls `teardownPlayer()` synchronously rather
> than pausing and letting the ~600ms idle timer clean up. This looked exactly
> like an autoplay-policy bug and wasn't.

---

## Tests

Component/behavior tests live in `src/test/` and run under Vitest + jsdom
(`npm test`). `src/test/setup.ts` wires up `@testing-library/jest-dom`, plus the
two shims Radix's slider needs to mount at all (below).

| File | Covers |
|------|--------|
| `PlayerMarks.test.tsx` | `b` / `[` / `]` / `\`, the add-toggle tolerance, the loop tick, the marks on the bar |
| `LocalControls.test.tsx` | the `<video>`→`PlayerApi` adapter, scrubbing, volume, driving either source, and the scrub popup (its frame, and where it stops at the ends) |
| `api.test.ts` | the error toast, `quiet` mode, reading the detail off a clone |
| `toastStore.test.tsx`, `audioStore.test.tsx` | the two external stores, incl. cross-tab volume sync |
| `time.test.ts`, `local.test.ts` | the clock, resume ratios, size formatting, the fetch helpers |
| `ext.test.ts` | the clean-embed capability: the marker, an unknown version, and that the answer is frozen for the page |
| `storyboard.test.ts` | picking a scrub frame: the walk across a sheet, crossing sheets, clamping, and scaling to a width |
| `quality.test.ts` | the resolution label: the names that say nothing on their own, and the ones that hide it |
| `timeWindow.test.ts` | the time-window ladder: clamping, snapping, the `age` round-trip, and the legacy params it replaced |
| `TimeRangeSlider.test.tsx` | the two thumbs, the tick notches and their alignment, clicking a label, and the keyboard |
| `VideoCard`, `VideoRow`, `Sidebar`, `TopBar`, `TimeSortControls`, `appHelpers` | the feed surfaces |

Four jsdom gaps have to be papered over, and each is a stub rather than a
behaviour change: `isContentEditable` is not implemented (so the shortcut guard's
own property is set by hand), there is no pointer capture (the scrub handler
takes it before seeking, and an unstubbed call throws before the seek), there is
no `ResizeObserver` (Radix's slider tracks the track's width with one, and throws
on mount without it), and every element measures zero, so the progress bar is
given a rect.

A fourth can't be stubbed, only worked around: **jsdom discards `clamp()`**. Set
one and the property reads back `''` with the style attribute `null`. So nothing
positioned that way can be asserted through the DOM — a test that seems to pass
is measuring something else. That's why `previewLeft` is exported from
`LocalControls` and its CSS asserted directly.

`VideoCard.test.tsx` has an `it.fails` pinning a **known bug**: a modifier-click
opens the in-app watch overlay as well as the YouTube tab, because the anchor's
early return doesn't `stopPropagation` and the click still reaches the card
wrapper. `PlayerMarks.test.tsx` pins another: a `b` pressed before the bookmark
list finishes loading is wiped from view by the load handler, though the POST
still saves it.
