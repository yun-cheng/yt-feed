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
  and `q` — the search on `/search`, and the same search confined to one channel
  on a channel page. See "URL state" below.
- Data is fetched from `/api/*` into React state (`fetchFeed`, `fetchTags`, …);
  the feed is paged by `offset`/`limit` with a load-more trigger (`loadMoreFeed`).
  Every call goes through `apiFetch` (`lib/api.ts`) — a drop-in `fetch` wrapper
  that shows an error toast on a failed request, so nothing fails silently.
  High-frequency background calls (hover captions/storyboards, the topic-build
  poll) opt out with `{ quiet: true }`.

### Language (`lib/i18n.ts`, `locales/`)

The app's own text comes in English, 繁體中文 (Taiwan), 日本語, 한국어, ไทย and
Tiếng Việt, chosen by the `app_language` setting (Settings → Language); `auto`
takes the first language the browser lists that the app has (any Chinese reads
繁體中文), or English.

- **Keyed by the English.** A message is written as `t('Watch later')`, so the
  source reads as it always did and English needs no table: a string missing
  from a table in `locales/` shows in English. `{name}` placeholders are filled
  from the second argument. `tn(n, '{n} video', '{n} videos')` picks a count's
  form; `tc('sort', 'Watched')` is for English that means two things (a sort
  order on History, a watch status elsewhere) and looks up `sort|Watched` first.
- **Module state, and a remount to change it.** `t` is called from plain
  helpers (`timeAgo`, `rangeLabel`, `formatCount`) as well as components, so
  the language is a module variable rather than context. `DefaultsLoader` keys
  the app by it, and saving a new language remounts everything below — the URL
  brings you back to the same page. The last language used is kept in
  localStorage, so the sign-in screen and the loading screen are already in it.
- **Call `t` when rendering, never at module load.** A constant built with `t`
  at import time is frozen in whatever language was current then. Lists of
  options (sorts, watch statuses, lengths, page names, tag groups) keep their
  English labels and are translated where they're drawn; since the catalogue
  test can't see those keys in a `t('…')` call, `locales/dynamic.ts` lists them,
  along with the settings spec's labels and descriptions, which arrive from the
  backend in English.
- **Numbers and times.** In Chinese, counts use 萬 and 億 (35.6萬) the way
  YouTube writes them there; the other languages take their short forms from
  `Intl`'s compact notation (35.6万, 35.6만, 12 Tr). Dates format for the
  language's locale (`locale()`: `zh-TW`, `ja-JP`…). The time slider's ticks
  use a short form (1月, 1สป, 1tu) to fit between their neighbours, and its
  heading the long one (過去 1 個月). A new tick label is worth checking at
  desktop width: the last tick is right-aligned against a centred one, so a
  long word for "all" runs into "1y" — Thai says ตลอด and Vietnamese hết there
  for that reason.
- **The catalogue test** (`test/i18n.test.ts`) scans the source for every
  `t('…')` / `tn(…)` and fails, for each language, on one with no entry, on
  an entry nothing uses any more, and on a translation that drops one of its
  English's placeholders.

What stays English: text the backend writes (error details, the archive
status line, notification bodies), YouTube's own data, and your tag names.

### URL state

Pages keep **separate** sort / window / watch-status state — a channel page's
sort isn't the feed's — but the URL carries **one** `sort`, `age` and `watch`.
The page being shown owns them; every other page's copy sits at its own default.
`lib/pageDefaults.ts` holds those defaults, and the `USES_*` sets say which
controls a page actually has, so a param a page can't change is never written.

The defaults come in two layers. `BUILT_IN_DEFAULTS` is the app's table, argued
for entry by entry. Over it sit your overrides, the `page_defaults` setting
edited under **Settings → Pages**. Only the fields you changed are stored, so a
page you never touched follows the built-in value. `defaultsFor(page)` reads the
two together, and everything else asks it: the URL's omit-if-default rule, a
cold load, the resets on arriving at a channel / History / a playlist, Home,
and a preset coming off.

- **Loaded before the first render.** `DefaultsLoader` (inside `SignInGate`)
  fetches `/api/settings` and installs the overrides before `App` mounts. `App`
  reads the URL into state on that first render, and a param equal to the
  default is absent from the URL, so the default decides what a plain link means.
  A failed read falls back to the built-ins.
- **Applied the moment you save.** Every page's view stays live until you change
  it, so `applyPageDefaults` resets the view of each page whose default moved,
  plus the feed's watch selection if its default moved. Watch Later and Imported
  share that selection, so they have no watch default of their own
  (`SHARES_FEED_WATCH`); the editor says so rather than offering one.
- **The editor** (`PageDefaultsEditor`) reuses each page's own `TimeSortControls`
  (`stacked` for the narrow column) and saves once per pause while you drag.
  Setting a field back to its built-in value removes the override
  (`withDefault`).

Each page's pair lives in one `views` record keyed by page (`PageView = {age,
sort}`), rather than a `useState` per page per control. The bar reads
`views[page]`, so adding a page's controls is a row in a table instead of two
more pieces of state and two more branches in the ternary that used to pick
between them. A channel page grows one more pill, **Relevance**, while a search
is narrowing it — Meilisearch's own order for the hits, which means nothing
without a query, so it appears and disappears with one. The Channels page grows
the same pill while its own filter is on; its relevance is worked out on the
server (`match_channels`), and `sort=relevance` is what asks for that order.

A search **borrows** that bar (`useSearchSort`, one hook for both pages):
starting one switches to Relevance (a search is a question about words, and
answering it in like-count order buries the video you typed the words for), and
ending one puts back the sort that was in force before. Only the two edges act,
so a sort picked mid-search stands, and a link that arrives carrying its own
`sort` is left exactly as it came.

`TimeSortControls` holds the matching sort table (`PAGE_SORTS`)
and renders the slider only when a window is passed to it — a page absent from
that table has no control bar at all.

Those same sets feed `pageFilters(page, shorts)`, which is what the **sidebar**
renders from — so a filter is either usable *and* in the URL, or in neither:

| page | Videos/Shorts | watch status | length | tags | topics | show hidden |
|---|---|---|---|---|---|---|
| feed | ✓ | ✓ | ✓ | ✓ | | ✓ |
| channel | ✓ | ✓ | ✓ | | ✓ | |
| history | ✓ | ✓ | ✓ | ✓ | | |
| watchlater | | ✓ | ✓ | ✓ | | |
| imported | | ✓ | ✓ | | | |
| playlist | | ✓ | ✓ | | | |
| channels | | | | ✓ | | |
| downloads / playlists / search / local | | | | | | |

The reasoning: tags live on **channels**, so they can't filter a page of videos
from channels you don't follow (imported), and a channel page swaps them for
that channel's own topics. Watch status needs a list of videos, which the
channels page isn't, and neither is a runtime. Videos↔Shorts needs a list
that's actually split that way.
Downloads, Playlists and Search do no sidebar filtering at all, so their filter
panel is empty.

- **Values equal to the page's default are omitted**, so ordinary URLs stay
  short — and the same value can be worth writing on one page and not another
  (`age=0-3` is the feed's default but not a channel's, whose default is `0-30`).
- `buildPath(state)` takes an object, not a positional list — there are ten
  fields now, and it's the one place that knows what a page's URL looks like.
- `q` is written on the search page, a channel page and every library page,
  and the page it sits on is what it means:
  on `/search` it's the search, and on a channel page it's that same search
  **confined to the channel** — which is the channel page filtered by text.
  A `?q=` on a channel page therefore *is* the scope (there is nowhere else it
  could be confined to), so the URL never names the channel twice. The box's
  "In this channel" is one button in two states — lit, with a check, when the
  scope is on — rather than a control that renames itself to the channel: the
  name is already on the page, and a button whose words change is a different
  button.
- The library pages — Channels, History, Watch Later, Downloads, Imported and a
  playlist (`SEARCHABLE_PAGES`, which also holds each button's words: "In
  history", "In this playlist", …) — have the same scope, and `?q=` on one of
  them is it. They filter on the client (`filterByText`: every word, anywhere
  in the title or channel name, case- and width-folded), since each already
  holds its whole list; a channel page is paged, so its search runs on the
  server — and so does the Channels page, which filters channels instead of
  videos: `?q=` goes to `/api/channels`, which matches the name (typos and
  Chinese segmentation included, via Meilisearch) and the topics. It is the one
  page that takes the scope automatically: a list of channels is all the box
  there could mean, so typing filters from the first keystroke — after the same
  `scopedQuery` pause a channel page takes — and the button is for widening back
  out. A search begun on one of them remembers where it came from
  (`searchFrom`), so the results page still offers to confine it back. The
  scope (`searchPage`) drops the moment you leave that page — an effect on
  `[page]`, which is safe here because a cold load of `/history?q=` *is* that
  page and has nothing to wipe — and opening another playlist drops it too.
  Text left in the box without the scope on stays out of the page's URL.
- `stateFromUrl()` is the inverse, and is used by **both** the cold load and
  `popstate`, so the two can't drift apart.
- **Navigations only name their page.** `setPage` / `selectChannel` push the
  bare path; the `syncUrl` effect then `replaceState`s the full query once the
  state has settled. Nothing else has to know the param list.
- Filters that reset on a fresh visit (a channel's watch status and topic label,
  History's and a playlist's watch status) are cleared **by the navigation**, not by an effect on
  `[page]`/`[channelId]` — an effect would also fire on a cold load and wipe the
  very value the URL just restored. A reload isn't a fresh visit.

#### `?t=` is the one param that isn't view state

`/watch/:id?t=300` starts the overlay 300 seconds in. It's a **handoff**, not a
filter: something that already knew the position saying so, once. The browser
extension's watch-page button is what writes it, passing YouTube's own playback
position so the app picks up mid-video instead of restarting.

That difference is why it's parsed by `parseStartAt` alongside `videoId` in
`parsePath` rather than by `parseQuery` with the sort and the window. Those
describe a view and survive every filter change; this one is **spent on
arrival**:

- `WatchPage` reads it once, into a ref, on mount. It's keyed by video id, so a
  different video gets a fresh instance and "start here" can't apply twice.
- `App` `replaceState`s it out of the URL as soon as the overlay has it.
  Otherwise it outlives its usefulness — half an hour later a refresh would jump
  back to the handoff point, when history has been recording where you actually
  are the whole time.
- It **beats stored history** and skips the near-the-end rule that would
  otherwise restart a nearly-finished video. Landing on the credits is exactly
  what you asked for if that's where you were.
- Whole non-negative seconds only. YouTube's own `1m30s` spelling is rejected
  rather than half-understood, and an empty `?t=` is absent rather than zero —
  `Number('')` is `0`, which would read as a deliberate "start at the top" and
  override the resume position it was meant to leave alone.

### Watch history

Every video remembers where you stopped. `WatchPage` reports its position every
10s while the player is actually PLAYING, and once more on the way out — through
the effect cleanup, with `keepalive` so the last report survives the page being
torn down. Reopening the video seeks straight back there.

The pieces that aren't obvious:

- **Two things race on open** — the saved position and the player itself, either
  can land first. `resumeAt` stays `null` until the fetch answers (so "not loaded
  yet" is distinct from "start at 0"), and the seek runs as soon as both exist.
  `onReady` fires inside the creation effect, before the position may have
  arrived, so it can't own this on its own; instead it bumps `playerGen`, which
  is the ready signal the seek effect keys off.
- **The seek is once per PLAYER, not once per page.** The embed can be rebuilt
  under us — a blocked unmuted autoplay is replaced by a muted player, and that
  one starts at 0 with the old seek already spent. A one-shot `resumedRef` meant
  the position survived only when no rebuild happened, which is exactly why a
  refresh always worked and a click sometimes didn't: a cold load has no gesture,
  so it starts muted from the first build and never rebuilds. `resumedForRef`
  remembers *which* generation it resumed for, so the replacement gets its own
  seek.
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
- **Watch Later and Imported share the global selection**; History, a channel
  page and a playlist each keep their own (see below).
- Selecting **every** status — or **none** — means "don't filter", matching both
  the tag filter and the backend, so an empty selection can't leave you staring
  at a blank page.
- **A channel page gets its own selection too**, cleared each time you open a
  channel — you open one to see what it has, not what's left of it, and one
  channel's filter shouldn't follow you to the next. The sidebar swaps the global taxonomy for that
  channel's topic chips there, but the watch-status section stays.
- **A playlist gets its own selection**, empty when you open one and cleared
  by each `selectPlaylist`: a playlist is a set you chose whole, so the default
  is all of it rather than the feed's unwatched-and-in-progress.
- **History gets its own selection**, not the global one — which hides watched
  videos, backwards on a page whose whole job is listing what you've watched.
  `unwatched` can't match anything there either, so that chip isn't offered. The
  selection starts **empty** (no filter) and is reset to empty by every
  navigation to the page, so it always opens showing everything and a filter you
  set last time can't ambush you — but a reload of a `?watch=` URL keeps it, a
  refresh being a continuation rather than a fresh visit. Toggling it there
  leaves the feed's selection alone, and vice versa.

### A tag chip is split: only this, or not this

One pill, two hit zones. The **body** (`🀄 chinese 90`) says *show only this*;
the **`−` segment** beside it says *hide this*. Each is its own undo — clicking
the state a tag is already in clears it — and switching sides is one click, with
no stop in between.

Deliberately **not** a 50/50 split, and deliberately not right-click:

- The common action keeps the big target. An unmarked half-and-half split on a
  ~28px chip makes two opposite outcomes a coin flip on touch.
- The divider makes the seam something you can **see** rather than something you
  have to be told about.
- Right-click would have been invisible, would have meant hijacking the context
  menu (which this app does nowhere else), and — since this sidebar renders on
  mobile — would have left exclusion with no way to reach it on a phone.
- A single cycling button was the first attempt. It made clearing an *include*
  pass through *exclude* on the way, which changes `selectedTags` and so fires a
  wasted feed refetch and a visible list swap.

- **One list, not two.** The selection stays a flat `string[]`, with an
  exclusion spelled `-chinese` — so the URL, the `tags=` query param and every
  consumer keep the shape they had. `isExcluded` / `tagName` read it, and
  `setTagState` is the transition, exported so both directions are testable
  without the component. A tag already set the other way is flipped **in place**
  rather than appended, so the filter pills don't reshuffle under the cursor.
- **Only the first character is the marker.** Tag names contain hyphens
  (`film-tv`, `real-estate`, `language-learning`) and none of them start with one.
- **An exclusion is a flat veto**, not part of the OR-within-a-group rule: a
  channel carrying it is out whatever else it carries. Two crossed-out chips are
  AND-NOT — grouped the other way, "not Chinese OR not Japanese" would be true of
  everything and narrow nothing.
- **Excluding alone still filters.** With nothing selected *for*, `allowed` is
  `null` rather than the empty set — "all of it except these" is a filter; an
  empty set would be a blank page.
- **The × on a filter pill clears, it doesn't cycle.** A pill you clicked to be
  rid of turning into its own opposite is the one thing that row must not do, so
  it calls `clearTag` rather than `toggleTag`.
- **A crossed-out chip's count excludes its own ban**, and so says how many
  channels you're hiding. Measured against itself the number could only ever be
  0, which is the one thing it can't usefully say.
- **Each zone says what it is**: `data-state` (`off` / `on` / `excluded`) on the
  body, `data-exclude` on the segment, and an `aria-label` on the segment so a
  screen reader gets "Hide chinese" rather than a bare minus sign. Two hit zones
  means two real `<button>`s, so exclusion stays reachable by keyboard and by
  touch — at the cost of doubling the tab stops through the tag list.
- **`onExcludeTag` is optional.** The channel-page sidebar swaps the taxonomy
  for that channel's topics and passes none, so the segment is inert there
  rather than broken.

### The summarised filter

A one-chip sidebar section under the watch statuses: **Summarised**, on or off.
One direction on purpose — "not summarised" is very nearly every video there is,
which narrows nothing worth the chip.

- **The split is the watch filter's, for the same reason.** The feed and a
  channel page are paged from the server, so they send `summarised=true` and the
  filter runs before ranking and paging (`total` counts what you'll be shown).
  Watch Later, History, Imported and a playlist hold their whole list already, so
  they use `filterBySummarised` on the client.
- **The client half reads the map the cards already read** — `summaryStore`'s
  `useSummarisedIds()`. That Set is rebuilt when the store changes rather than in
  the selector: `useSyncExternalStore` compares snapshots by identity, so a Set
  built per read would be a new object every render and never settle.
- **`done` only, on both sides.** A job still running has nothing to read yet and
  one that errored has nothing at all. The backend's `summarised_video_ids` is
  the single definition, shared by both endpoints so the word can't come to mean
  two things on two pages.
- **URL-only, unlike the watch statuses.** "Show me the ones I've had
  summarised" is a look at a list rather than a standing preference: it shouldn't
  still be on tomorrow, and a link should carry it (`?summarised=1`).
- **Not on the Channels page**, which lists channels — a channel has no summary.

### The length filter

Four chips under the watch statuses — **Under 5 min**, **5–10 min**, **10–20
min**, **Over 20 min** — multi-select, and read exactly as the watch statuses
are: none on, or all four on, is *no filter*, so an empty row can never leave
you staring at a blank page.

- **The cuts are 5 / 10 / 20, not YouTube's 4 / 20.** It started at YouTube's,
  for the familiarity, and moved because that put *half* this library in the
  middle chip — 31 / 52 / 17, against 37 / 23 / 24 / 17 for these — and a chip
  holding half of everything narrows almost nothing, which is the one thing a
  filter is for.
- **Closed in Shorts mode.** Every Short is a couple of minutes at most, so the
  buckets would be one chip that keeps the lot and three that can only empty the
  page. `pageFilters` takes the mode alongside the page for this — the only
  thing besides the page that can close a section — and only where the mode
  governs the list: Watch Later, Imported and a playlist never split into Videos
  and Shorts, so their buckets stay open. Hiding the chips isn't enough on its
  own, so `modeLengths` sets the selection aside as well: a filter still in force
  with nothing on screen to turn it off is the one thing these rules exist to
  prevent. *Set aside*, not cleared — the URL goes on carrying it, so switching
  back to Videos (or reloading) finds the chips as you left them.
- **The bounds are half-open**: 5:00 begins "5–10" rather than ending "under 5",
  so no video is in two buckets. The table is `VIDEO_LENGTHS` +
  `LENGTH_BOUNDS` in `App.tsx` and `LENGTH_BUCKETS` in `routers/tags.py`; the
  two have to agree, because…
- **…the split is the summary filter's, for the same reason.** The feed and a
  channel page are paged, so they send `?length=` and the backend filters in the
  WHERE — before the window cap, so the cap is spent on videos you asked for and
  `total` counts what you'll be shown. The loaded lists use `filterByLength`.
- **A video of unknown length is in no bucket.** A missing duration arrives as
  `0`, and 0 is "we never probed it", not "under five minutes" — filing it in
  the shortest bucket would quietly stuff every unprobed video there. It comes
  back the moment you stop filtering, which is the only honest place for it.
- **One selection for every page**, unlike the watch statuses, which History and
  a channel page keep their own copies of. "I have twenty minutes" is about you,
  not about the list you happen to be looking at.
- **The bounds are in the names** (`under5`, `5to10`, `10to20`, `over20`),
  because they *are* the meaning of a bucket. Move one and the old name retires
  with the old range: an unknown name is dropped rather than 422'd, so a saved
  preset loses the filter out loud instead of quietly coming to mean a range
  its owner never chose.
- **URL-only** (`?length=under5,over20`), like the summary filter and for the
  same reason: a length is a mood this afternoon, not a standing preference.

### Filter presets

A sidebar selection, named and put back on with one click. The section sits
above the watch statuses in both sidebar branches, because it's the shortcut
past everything below it: the chips build a selection, this puts one back on.
`lib/presets.ts` holds the model and the calls; `App.tsx` owns the state.

- **A preset is a filter set and nothing else** — no page, no sort, no window.
  So one preset ("unwatched, not Shorts") works on the feed, History and Watch
  Later rather than being one preset per page. Applying it walks `pageFilters`
  and skips whatever this page doesn't offer.
- **Only the pages with the full filter set show the section** — tags, watch
  status, length and summaries: the feed, Watch Later and History
  (`offersPresets`). Imported, a playlist and a channel page have no tags, so a
  preset there could only be half-worn. Judged without the Shorts mode, so
  switching to Shorts doesn't make the section vanish.
- **`watch: null` ≠ `watch: []`.** Saved from a page with no watch chips, a
  preset has nothing to say about the statuses and mustn't clear them the first
  time it lands somewhere that has them. An empty list is the explicit "no watch
  filter", the same distinction the URL spells `?watch=none`.
- **An empty watch list is still something to save.** Turning every status
  chip off is a selection — the pages open on unwatched-and-in-progress, so
  "show me the lot" is a state you asked for — and `hasAnyFilter` counts it,
  which is what puts the Save button there and lets such a preset light up as
  the one in force. A null list stays nothing, being the preset with no opinion.
- **The lengths run the other way**, because *their* empty list is the default:
  no chip on is "any length", which is what you get without asking, so a preset
  holding only that would restore nothing. Null still means "saved somewhere
  with no length chips" and is still passed through untouched.
- **`captureFilters` records only what the page showed.** `showHidden` is live
  state even on History, which has no switch for it — saving there would
  otherwise smuggle in a value you never set.
- **`forPage` trims what this page can't wear.** History has no *Unwatched*
  chip, so a preset carrying it drops it on the way in; otherwise a filter would
  be in force with nothing on screen to show it or turn it off. Both applying
  and the is-this-one-on comparison go through it, so the two can't disagree.
- **`isActive` fails a preset that sets a section the page isn't showing.**
  Otherwise a preset of tags plus the default statuses would light up on a page
  with no tag chips, looking applied while half of it isn't. A null watch or
  length list is skipped, matching what applying it does. Only one chip lights
  up — two presets that select the same thing are one filter under two names.
- **Clicking the chip that's on takes it off** (`takeOffPreset`): each section
  it set goes back to the page's default, and a null watch or length is left
  alone, as applying leaves it.
- **A preset belongs to the page it was put on.** Tags, summaries and lengths
  are one selection for every page, and the feed and Watch Later share a watch
  selection, so without this a preset applied on the feed would still be in
  force on Watch Later. `setPage`, `selectChannel` and `selectPlaylist` take the
  active one off on the way out (through `leavePresetRef`, since they're
  declared before the presets). Back restores it with the rest of the URL.
- **The `×` arms before it fires**, and only the zone itself reddens. Colouring
  the whole chip would paint it in the excluded-tag palette, which in this
  sidebar already means "not this" — a pending delete would read as a
  reverse-select.
- **Server-side, not localStorage**, like Watch Later and hidden channels: a
  preset is about how you look at your library, not about this browser.

### The time window

`TimeRangeSlider.tsx` is a two-handled slider over a fixed ladder of day
boundaries, and `lib/timeWindow.ts` is the model both it and the URL agree on:

```
days:    0     1     3     7    14    30    90   180   365    ∞
label:  now   1d    3d    1w    2w    1m    3m    6m    1y   all
index:   0     1     2     3     4     5     6     7     8    9
```

A window is a `TimeRange` — a `{lo, hi}` pair of **indices** — which the wire
format spells in days: `?age=3-14`. Indices are what the slider moves in and
what keeps the short windows reachable, since the ladder is spaced by index
rather than by days; 1d and 1y are one notch apart either way.

This replaced eight preset buttons plus a narrow/wide toggle. Those could only
reach ranges anchored at 0 ("wide") or exactly one notch wide ("narrow") — 15 of
the pairs the ladder allows. Naming both edges reaches all of them, and the
toggle disappears into the question "is `lo` at 0?".

**The last rung is unbounded.** `TICK_DAYS` ends in `Infinity`, spelled `all` on
the wire: `?age=0-all` is "All time", `?age=30-all` is "Older than 1m". It costs
almost nothing to carry because the range arithmetic is entirely by index —
`clampRange` never looks at a day count — so only the four functions that
translate an index into days know it exists. Two of them have a trap worth
knowing: `parseAge` special-cases the token before calling `nearestTick`,
because `|∞ − ∞|` is `NaN` and would compare false against every rung and land
on index 0; and `nearestTick` can never *return* the rung, so a hand-edited
`?age=0-99999` still means the past year rather than quietly meaning everything.

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

### The library pages

Watch Later, Imported, Downloads, History and **one playlist** are lists **you
built**, not a stream of what's new, and they share one control bar because they
share one shape. All five open on **All time**, sorted by the order the list
keeps itself in — labelled for what that order means on each: `Saved`, `Added`,
`Added`, `Watched`, `Order`. That token is `recent` everywhere, because it means
the same thing everywhere; only the word differs.

A playlist is the newest member and the one whose label is doing the most work.
`Order` rather than `Added` because an imported playlist's order is *YouTube's*,
reproduced deliberately by spacing `added_at` a second apart on import — so
`recent`, which leaves the order alone, is the option that preserves it. It's
also why the default matters more here than anywhere else: any other opening sort
would silently destroy the one thing the import went to trouble to keep.

Note the split: **one playlist** gets this bar, the **playlists grid** doesn't.
The grid lists playlists, not videos, so there's nothing for a video sort or a
video window to act on. That's why `playlist` no longer folds into the
`playlists` top-bar variant the way `localfolder` folds into `local`.

A playlist offers no **tag** filter, for the same reason Imported doesn't: tags
are attached to channels you follow, and a playlist can hold anything.

The reason for both defaults is the same. A list you assembled has no "too old
to bother with" — you put something there to come back to it, so a three-day
window would hide nearly all of it on the first visit, and ranking it by likes
answers a question about the videos rather than about your list.

**Their window filters a different date.** The feed and a channel page window by
publish date, because they're asking what's new. A library page windows by the
moment a row *joined the list* — `created_at` on Watch Later, Imported and
Downloads, `watched_at` on History. `filterByTime(items, age, stampOf)` takes
that accessor as an argument, which is the whole point: windowing History by
publish date would drop a decade-old video you watched an hour ago, and it
wouldn't agree with the sort sitting right next to it.

**A playlist is the exception, and it earns it.** It windows by `published_at`,
like the feed and a channel page. An imported playlist has every row stamped
within the same second — the import wrote them all at once — so windowing by
"when it joined the list" can only ever answer *all* or *none*. That's not a
filter, it's a dead control. A playlist is shaped like a channel page rather
than like a queue: a body of videos spanning years, where "the ones from this
year" is the question worth asking, and where the answer agrees with the Newest
/ Oldest sorts beside it.

The API still serves a playlist item's `added_at` as `created_at` — the same
name the other library pages use for the same moment — because it's what the
list's own `Order` depends on, even though nothing windows by it.

Two details in `lib/timeWindow.ts`:

- `stampMs` assumes **UTC** for a zoneless timestamp. The API writes
  `datetime.utcnow().isoformat()`, and `new Date` reads a zoneless *datetime* as
  local — enough to push something you saved this morning out of a `1d` window.
  A bare date has the opposite rule (already UTC by spec), so only the `T` form
  is corrected. A stamp that carries its own zone (`Z`, `+00:00`) is read as
  written; some `published_at` values arrive that way. Every place that turns a
  server stamp into a time goes through it: the window, the Newest/Oldest sort,
  `timeAgo` and the notification bell.
- A row with **no** stamp is kept, on every window. Missing means the field
  predates the row, not that the row is infinitely old, and dropping it would
  make it unreachable even at "All time".

### Adding a channel (`AddChannelDialog.tsx`, `lib/channels.ts`)

The feed is the videos of the channels the app holds, and a subscription isn't
the only way one can get there. Two entry points, one pair of calls
(`lib/channels.ts`, shared with the extension's service worker):

- **The Channels page** has an *Add channel* button. Paste a link, an `@handle`
  or a bare id, press *Look up*, and the resolved channel appears as a card —
  avatar, subscriber count, description — before anything is written. Two steps
  rather than one because a handle is easy to mistype into a *different real
  channel*, and a picture answers "is this the one I meant?" in a way a spinner
  can't. A hand-added channel's card also grows a remove button (an in-place
  confirm, because removing takes its videos with it); a subscribed one doesn't,
  since the server refuses those.
- **`/channel/:id` for a channel we don't hold** used to say "Channel not
  found." and stop. It now looks the channel up and renders its real header with
  an *Add to your feed* button — which is what you want, because the way you
  arrive here is by clicking through to the uploader of an imported video.

Both channel pages draw that header through **`ChannelHeader.tsx`**, which is
where the avatar, name, subscriber count, description (with its own Show
more/less, since the measurement that gates it is a fact about that element) and
the Open-on-YouTube link live. The pages differ only in what hangs off it, so it
takes three slots: `aside` for the tag editor, `children` for the archive
readout, and `actions` for the Add button. It was extracted rather than written
that way — the first version of the not-yet-added page copied the markup, which
is how two headers quietly stop looking alike.

**Neither waits for the videos.** `POST /api/channels/add` returns as soon as the
channel exists, carrying `scanning: true`; `ChannelPage` re-fetches every 3s
while `channel.scanning` holds, and the empty grid says "Fetching this channel's
recent videos…" rather than "No videos in this time range" — a distinction the
page can only make because the server sends the flag. The poll re-arms off a
tick counter: every refetch replaces `channel` with an equal-looking object, so
nothing in the effect's deps would otherwise change.

`apiFetch` gained `quietStatuses` for this: the channel page's 404 is now its own
normal path (it's how the page learns the channel isn't ours), so it shouldn't
raise an error toast, while everything else still does. That's the difference
between it and the blanket `quiet`.

### The Imported page

`/imported` lists videos added by pasting a link (`ImportedPage.tsx`), rendered
by the **same `VideoRow`** the home feed uses — so the cards, the hover preview
and every action (watch, download, save to playlist, watch later) are identical;
only the source of the list differs. `ImportDialog.tsx` is the paste modal, and
the TopBar grows an **Import** button at the top right on this page only.

Three deliberate differences from the feed:

- **A library control bar, not the feed's.** It opens on all time and on import
  order (`Added`), and its window filters by when you imported something rather
  than when it was published — see "The library pages" below.
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
  Sidebar.tsx / TopBar.tsx        chrome: nav, search box (with the "in this
                                  channel" scope at its right-hand end), tag
                                  filters, saved filter presets
                                  (on a channel page the sidebar swaps the
                                  global taxonomy for that channel's topic chips)
  TimeSortControls.tsx            the time-window slider + sort pills (plus
                                  Relevance, while a search narrows the page)
  TimeRangeSlider.tsx             two-handled window picker (see "The time window")
  VideoCard.tsx                   the card + hover preview (the complex one)
  VideoRow.tsx                    list-row variant
  ChannelPage.tsx / ChannelsPage.tsx
                                  ChannelPage takes a `q`: a search confined to
                                  this channel filters the page in place, so the
                                  window, sort, topics and watch statuses go on
                                  applying to what it finds. ChannelsPage takes
                                  one too and refetches the grid for it; the
                                  matching and ranking are the server's
  ChannelHeader.tsx               avatar/name/subs/description/YouTube link —
                                  shared by the held and not-yet-added pages
  AddChannelDialog.tsx            paste a link or @handle, preview, add
  ChannelTags.tsx                 per-channel label editor (apply/remove/suggest)
  ChannelArchive.tsx              how much of a channel's history is held, and
                                  the button that fetches the rest
  SettingsPage.tsx                renders itself from the spec /api/settings
                                  serves — adding a setting is a backend change.
                                  A `choice` is a menu; saving a language, a
                                  caption default, the playback speeds or a
                                  shortcut applies it at once.
                                  Badges the ones scoped to the whole machine,
                                  and shows the extension's API key to copy
  PageDefaultsEditor.tsx          the `page_defaults` setting's control: each
                                  page's opening window, sort and watch filter
  DefaultsLoader.tsx              holds the app back until your settings load
                                  (page defaults, language, caption languages),
                                  and remounts it when the language changes
  People.tsx                      who shares this app; adds someone and hands
                                  back the login link to send them. Composes the
                                  link from window.location.origin — the API
                                  can't, see its comment
  SignInGate.tsx                  wraps the app: shows it, or the way in. Gates
                                  on /api/auth/me's `resolved`, so a one-account
                                  machine never sees it
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
  SpeedsEditor.tsx                the playback-speed list, on the settings page
  ShortcutsEditor.tsx             every shortcut and the key it's on; rebinds by
                                  listening for the key you press
  PlayerMarks.tsx                 bookmarks (`b`) and a video's saved A–B loops
                                  (`[`, `]`, `\`): state, shortcuts, the actions
                                  behind the bar's two buttons, and the marks
                                  drawn on the progress bar (ours, or a rail
                                  over the embed's)
  SearchPage.tsx
  WatchPage.tsx                   in-app player (/watch/:id) — the embed, or the
                                  downloaded file with our own control bar;
                                  keyboard controls, our own captions (language
                                  switcher, dual subtitles, AI translation),
                                  metadata, description, topic chips
  AskPanel.tsx                    Ask: a conversation about the video, answered
                                  from its transcript. Shares the right-hand
                                  panel with the transcript, one tab each
  Comments.tsx                    the comment section under the description —
                                  closed until asked for, and fetched only then
  Toaster.tsx                     the app's single toast surface: errors, and
                                  the removals you can still take back
  NotificationBell.tsx            the bell in every TopBar: what finished while
                                  you were on another page
hooks/
  audioStore.ts                   shared, persisted preview VOLUME
  toastStore.ts                   tiny global toast store: API errors, and
                                  undo offers (pushUndo)
  notificationStore.ts            the bell's rows + unread count, slowly polled
  summaryStore.ts                 which videos have a long summary, and which
                                  are having one written — polled only while
                                  something is running
lib/
  api.ts                          apiFetch — fetch wrapper that surfaces failures
  undo.ts                         the removals you can take back: delete, then
                                  offer the server's receipt back
  presets.ts                      saved sidebar filter sets: the model + its calls
  ext.ts                          is the clean-embed extension installed?
  quality.ts                      YouTube's quality names → "1080p"
  local.ts                        local-folder types + fetch helpers
  storyboard.ts                   YouTube's scrub sprite sheets → one frame
  time.ts                         formatTime — the player clock; timeAgo — "5m ago" on cards and the watch page
  i18n.ts                         t / tn / tc and the current language (see "Language")
  captionDefaults.ts              the caption languages every video opens with
  richText.tsx                    YouTube free text (descriptions, comments):
                                  URLs as links, timestamps as seek buttons;
                                  formatCount (1.2M, or 35.6萬 in Chinese)
  markdown.tsx                    the slice of Markdown a model writes, rendered
                                  — leaves go through richText, so a timestamp
                                  inside a bullet still seeks
locales/
  zh-Hant.ts                      繁體中文, keyed by the English it replaces
  ja.ts, ko.ts, th.ts, vi.ts      日本語, 한국어, ไทย, Tiếng Việt — the same keys
  dynamic.ts                      keys that reach t() through a variable
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
  `hooks/audioStore.ts` (a tiny `useSyncExternalStore`). Every value it takes is
  **snapped to a multiple of 5** (`VOLUME_STEP`), so a drag can't leave it on 48.
  The **boost** (`hooks/audioBoost.ts`) is the opposite scope — see the control
  bar below.
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

The middle case is gated on `overlayOpenRef`, which means *the overlay is open
over a page we navigated from* rather than merely *the overlay is open*. The
difference is a **refresh on a video**: the overlay comes back, but nothing is
behind it — `parsePath` reports `page: 'feed'` for a `/watch/:id` URL because
that's the sensible default when there's no history to say otherwise. Treating
the next back as a close would leave you on that default feed instead of the
channel page you actually came from, so the ref starts `false` on a cold load
and back rebuilds the previous page from its URL like any other navigation.
That branch also clears `selectedVideoId`: the URL it's going to has no video in
it, so an overlay still open is one we're leaving, not one we're closing.

Other details:

- **Volume is shared with previews** both ways: the store's volume is applied on
  ready, live changes follow, and using the embed's own volume control mirrors
  back to the store. The store snaps to `VOLUME_STEP`, so an embed-side 48 is
  written back to the embed as 50 — a no-op set emits no store update, and
  without that write the two would sit two points apart forever.
- **Autoplay**: unmuted when a page gesture allows it (so it plays with sound
  immediately), muted otherwise (e.g. a cold-loaded `/watch` link). A *blocked*
  unmuted autoplay doesn't error — it wedges on a buffering spinner — so a
  watchdog notices playback never started within ~4s and rebuilds the player
  muted, which always plays.
- **Up next**: when the video ends, a card over the player offers the same
  channel's next video **forward in time**, and a next button in the control bar
  goes there without waiting for the end — see below.
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
  `↑`/`↓` volume (the embed doesn't map these itself), `c` captions, `p` pin,
  `,`/`.` playback speed (YouTube's two keys, without the shift it asks for), and
  the marks below (`b`, `[`, `]`, `\`). **Every one of those is a default, not a
  wire**: the handler asks `lib/shortcuts.ts` what a key *means* and the answer
  comes from the `shortcuts` setting, so a rebound key moves in all three
  handlers at once (see "Shortcuts are a setting" below). We focus our
  box, not the iframe, and pull focus back whenever a click lands in the video —
  a cross-origin iframe otherwise swallows its own keys. A brief volume HUD shows
  while adjusting.

  Every shortcut is a **bare** key: both handlers (here and `PlayerMarks`) return
  early on `metaKey`/`ctrlKey`/`altKey`. They match on `e.key`, so without that
  guard `⌘C` reads as `c` — and `preventDefault` on it means **you cannot copy
  text out of the app**. `⌘F`, `⌘K`, `⌘M` went the same way, and on a Mac `⌘[`
  and `⌘]` are back and forward. Pinned in `PlayerMarks.test.tsx`.
- **Bookmarks and A–B repeat** (`PlayerMarks.tsx`): `b` marks the moment, `[` and
  `]` set the ends of the passage that's repeating, `\` stops it. Both drive the
  player through `PlayerApi`, so they behave the same over the embed and over a
  file on disk, and both are stored per video, so they're still there next time.
  - **Both also have a control-bar button**, because a feature that lives only on
    a shortcut is one you have to have been told about — and these are the only
    marks on the bar you can't otherwise put there. The hook hands the buttons
    the same actions the key handler calls, so the two ways of asking can't
    drift apart. They sit next to the caption button in both placements: in our
    row when we own the bar, floating over YouTube's chrome when we don't.
  - **One end is enough to repeat** (`loopBounds`). An unpinned A means the start
    of the video and an unpinned B means the end of it, which is what each key
    reads as on its own: `[` is "repeat from here", `]` is "repeat up to here".
    Requiring both made the first press a keystroke that visibly did nothing.
    The ends are resolved against the length the player reports **at each tick**,
    not once when the loop was pinned — the embed doesn't know the duration for a
    moment after it's handed a video, and until it does, a loop with no B simply
    doesn't run (`duration` of 0 is "ask me again", not a video of no length).
    Two consequences worth knowing: the tick also takes the player **ending** as
    reaching B, since a player can stop a hair short of the duration it reported
    and then nothing ever passes it; and the bar dims for a one-ended loop like
    any other, with one of the two veils coming out zero-width.
  - **`looping` and `loopStage` are different questions**, and the button asks
    both. `looping` is whether the video is actually repeating — true with one
    end pinned. `loopStage` is what the *next* press does. A one-ended loop is
    ordinarily both at once: running, and still offering to pin the other end, so
    the button carries the underline and the A/B badge together.
  - **A video keeps as many passages as you mark** (`SavedLoop`, `/loops`), and
    the button opens the list of them (`LoopMenu`). It used to cycle — pin one
    end, pin the other, clear — but once a video can hold several, the question
    the button answers stopped being "what's the next step" and became "which
    one", and that has as many answers as you've marked. The cycle lives on in
    the keyboard, which is where it was always faster.
    - **`active` is what a bookmark doesn't need.** A bookmark is a point, so
      marks coexist; a loop is a mode, so only one passage repeats at a time.
      `[`, `]` and `\` all act on that one: pinning an end with nothing running
      *opens* a passage, so a video you've never looped behaves as it always did,
      and every press after that moves that passage's ends rather than piling up
      new ones.
    - **Stopping is not deleting.** `\` and the menu's *Stop repeating* set
      `active: false` and keep the passage — it's work, and the key that turns
      the repeat off shouldn't throw it away. The × in the menu deletes, and
      promotes nothing in its place.
    - **The menu closes when you choose a passage to work on** (switching to one,
      or starting a new one) and stays open otherwise: once you've picked one you
      want to hear it and the panel sits over the video, but pinning, deleting
      and stopping are all things you may do twice in a row.
    - **Switching seeks to the top of the passage.** You picked it to hear it,
      and a switch that left you outside would make you wait for the loop to come
      round before anything happened.
    - **A passage that hasn't reached the server carries a negative id**, the way
      a fresh bookmark does. Nothing is sent under one; the POST that made it
      reconciles whatever happened while it was in flight — an end moved goes out
      under the real id, and one deleted in the meantime is deleted from the
      server too.
  - **The button still says how far along the pinning is** (`loopStage`: idle →
    arming → running). Armed, a small **A** or **B** names the end still open,
    which is the one thing the list can't tell you at a glance; repeating, the
    caption button's underline. Both in white, since the loop wears no colour of
    its own on the bar either.
  - **On the bar, only the running passage dims.** The others draw their cuts
    half as dark (`LOOP_EDGE_IDLE`) and take no clicks — switching is the menu's
    job, and every hit area over the embed is a pixel of YouTube's own scrubber
    taken. Several dimmed spans would turn the bar into a ladder of veils.
  - **Clearing a bookmark** is the same button, which says which of the two it's
    about to do: it fills in and reads *Clear this bookmark* while the play head
    is standing on one (`markHere`, polled at 500ms against a 2s tolerance — the
    position moves on its own, so it can't be derived; it's a boolean, so it
    costs a render only as you cross a mark, and the toggle sets it itself rather
    than waiting for the next tick). Clicking a tick seeks exactly to the moment
    it marks, so **click the tick, then press the button** clears one without
    hunting for the moment by hand.
  - **Passages persist** (`/api/bookmarks/{videoId}/loops`), including which one
    was running. A loop is work on a passage — the bar of music, the sentence in
    the other language — and that work is about the video, not about the sitting
    that pinned it. Every change goes through `writeLoops`, so what's on screen
    and what's stored can't drift; it writes `loopsRef` itself rather than waiting
    for the next render, because two presses can land inside one. The load is a
    round trip and `[` gets pressed the moment the passage arrives, so it
    **doesn't land on passages marked since** — the press wins.
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
  - **Both live on the progress bar** (`MarkTrack`) — that's the axis they're
    positions on, and anywhere else you have to translate a timestamp back into a
    place in the video. But only one of the two is a **mark**, because a bookmark
    is a **point** and a loop is a **mode**. The bookmark is a tick standing in the
    track it's a position on, in **sky-400** — one hue worn everywhere it appears,
    on the tick, on the button that made it and on the dot of the line confirming
    the press.
  - **The loop restyles the bar instead of marking it.** Its ends cut the track
    (a dark 2px notch, like the gaps YouTube puts between chapters), and once
    it's really running everything **outside** it dims back behind a black veil,
    leaving the repeating stretch as the only part of the bar at full strength.
    Nothing is drawn over the track for it, so there's no second colour to place
    against the player's red and white, and the fill still reads *through* the
    veil — dimming the played portion outside the loop is the point, that being
    exactly the part you've stopped watching. The thumb and any bookmarks are
    drawn after the veil and stay bright: the play head is never in question, and
    a bookmark isn't the loop's business.
  - **A half-set loop cuts but doesn't dim.** Dimming the rest of the video would
    claim something is repeating when nothing is; a notch claims only that you
    pinned this moment. It's also why the button carries the A/B letter — with no
    region to look at yet, that's what tells you which end is which.
  - Each mark is centred in a 12px hit area and **carries its own
    `left-1/2`**: absolutely positioned with no `left`, it lands at that area's
    left edge instead, drawing the mark 6px before the moment it stands for.
  - **The tick grows inside that hit area** (5×14 → 8×18, `group/mark`), the way
    the track thickens under the pointer. What grows is the tick, not the target
    — over the embed these sit on YouTube's own scrubber, and every pixel of hit
    area is a pixel of its bar we've taken. Growing on *approach* rather than on
    a direct hit is the point: by the time the pointer is in the zone you've
    committed to that mark, and the tick answering tells you you'll land it.
    Being over the bar, the hover also raises the scrub preview of the exact
    frame the bookmark holds.
  - **Every mark is clickable** and jumps to itself — on our own bar that beats
    the bar's own click, which would only land near the mark (the press stops
    propagating, so the bar doesn't also treat it as a scrub). Each tick sits in
    a wider invisible hit area, since a few pixels is not a target.
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
  centered, full-width.
- **Caption menu (two columns)**: a CC button sits in the player's bottom-left row,
  as a third button next to the embed's built-in share / watch-later, and opens a
  **two-column** picker — **Main** | **Second**. Each column lists every language
  this video actually **provides** among English / 中文 / 日本語 / 한국어 / ไทย /
  Tiếng Việt (`/api/feed/caption-langs`) — uploaded subs or the original ASR track, not
  YouTube's on-the-fly auto-translations — plus the AI translation (below). There's
  no "Off" row: an empty slot **is** off, and clicking the active row toggles it off
  (the `c` shortcut still hides everything). A saved language is only honoured on a
  video that actually offers it (`effCaptionLang`) — otherwise the backend hands back
  a machine *translation* of another track, which once surfaced as a Japanese
  transcript on a video with no Japanese captions. The default is kept for the
  next video that does have it.
- **Which languages a video opens on**: the `caption_lang` / `caption_lang2`
  settings (Settings → Language, `lib/captionDefaults.ts`), saved to your
  account, so they follow you to another browser. A pick made on a video lasts
  for that video; the next one opens on your defaults again. How captions look —
  on or off, word-by-word, position, size — is still remembered per browser.
- **Caption display (position, size, reset)**: a **Display** section under the two
  columns, because it applies to both. **Position** puts the block at the top or the
  bottom of the player — top is for a video whose own subtitles are burned in along
  the bottom, or one whose lower third carries the diagram. **Size** is a multiplier
  on YouTube's 2.5%-of-player-width, 50% – 300% in **10% steps** — YouTube's own
  ladder jumps 100 → 150 → 200, which on a player this wide are different decisions
  rather than adjustments. Everything else in the block is in `em` or a share of the
  width, so the box, its padding and the word-by-word line's fixed width all grow
  with the text. **Reset** returns those two
  and only those two — the language picks are choices about *what* you're reading and
  losing them is not what anyone means by resetting the position. Both persist with
  the rest of the caption prefs.
  - **Clearing the control bar** is the whole reason the bottom offset isn't a
    constant. Ours comes to ~4.5rem (bottom padding + button row + the progress
    bar's hit area) and the captions sit at 4.75rem while it's up, dropping to
    1.5rem when it fades — the old flat 3.5rem drew the text straight through the
    progress track. YouTube's bar can be neither measured nor watched from outside
    the iframe, so that one keeps a fixed `max(11%, 5.5rem)`: 11% tracks the bar on
    a big player, and the floor covers a short one, where the embed scales its bar
    *up* into that 11%.
- **Main + Second (dual subtitles)**: the two slots overlay two tracks stacked in the
  player — e.g. original + translation for language learning. The **Main** track is
  always the primary (top) line; the **Second** sits beneath it (the *slot*, not the
  content, decides the order). Both share one renderer (`CaptionBlock`), and the menu
  stays open so both can be set in one pass. A slot can't hold the same track as the
  other, and there's never a Second without a Main, so the picks stay consistent
  (`setSlots`): toggling the Main off promotes the Second up; picking the Second's
  language as Main clears the Second; picking the Main's language as Second swaps the
  two.
- **Generate captions**: on a video with **no track at all**, the menu has no
  languages to list — so instead of the two columns it shows one row, "⚡ Generate
  captions", and the caption button appears for that alone (`offerGenerate`). It
  is the only place captions are ever chosen, so it is the only place the offer
  can live. Pressing it POSTs to `/api/feed/captions-generate/:id` and then polls
  every 2s, rendering cues **as they land** — a job runs at ~8.6x realtime, so the
  transcript outruns the play head almost immediately and waiting for it to finish
  would buy nothing. Progress is drawn in **seconds of audio** (`covered` /
  `duration`), which is what the work is actually measured in, not requests.

  Two things the polling has to get right. A running job **writes captions**, and
  the probe that decides whether to make the offer **reads them** — so `genOwned`
  hands ownership of that state to the poll the moment a job starts, or the first
  window of cues would reset the progress it is reporting. And a job found already
  running (another tab, or a reload mid-transcription) is **adopted** rather than
  merely displayed, since a percentage that never moves is worse than none.

  The lines themselves are the backend's business, not this component's: they
  arrive already cut to a readable width at punctuation, and already in
  Traditional Chinese, so nothing here has to know that Whisper's segments run to
  fifteen seconds or that it writes Simplified.

  When it finishes, the language menu is refetched: the generated track takes its
  place as an ordinary language (`generated: true`, and `native` too, since it is
  what `/captions` serves), and from then on this video behaves like any other —
  including being AI-translatable, which for a Simplified-Chinese transcript is
  most of the point.

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
  back to the player); the `×` in the tab strip above closes the panel. Following
  stands down while searching.

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

### Live broadcasts

A stream that is on air is a different shape of thing: no total to run towards,
and a far end that keeps moving. The bar reads that off the player rather than
off the video row — `playerIsLive()` asks `getVideoData().isLive` over the embed,
and on a `<video>` asks whether the source has an end at all (an endless one
reports `Infinity` for its duration, which `getDuration` otherwise flattens to
0). Liveness is a property of the *moment*: a stream that was live an hour ago is
a recording now, and a stored flag would be stale by however long it has been
since the last sync. It's polled with everything else, so a broadcast that ends
under you turns back into an ordinary video with an ordinary clock.

- **The clock becomes a LIVE pill.** The elapsed time still shows, counted from
  when the broadcast went on air — the same direction a recording's clock runs,
  minus the total there isn't one of. Not a countdown from the edge: that number
  runs backwards while the picture runs forwards.
- **The dot is the tell.** Red at the edge, grey once you've fallen behind, which
  is the distinction the word "LIVE" can't make on its own — the stream is live
  either way. Clicking the pill seeks to the edge *and plays*, since one way to
  be behind is to have paused.
- **`LIVE_EDGE_SEC` is 10, never 0.** The play head trails the edge by a few
  seconds even when you've done nothing but press play — that gap is the buffer,
  and a tighter threshold would leave the button lit permanently.
- **The track is the elapsed broadcast**, so scrubbing back into YouTube's rewind
  window works exactly as it does on a recording; the play head can read a hair
  *past* the edge (the two are sampled a moment apart), so the fill is clamped.
- **The resume seek is confirmed, not just issued.** A seek made at `onReady`
  can be thrown away by the player's own startup, and live is where that bites:
  a live player puts itself at the broadcast's edge the moment playback really
  begins, so a resume that lands first is simply gone — an hour from where you
  paused rather than the few seconds a recording would cost. So the effect waits
  for state 1 and, if the position isn't within `RESUME_CONFIRM_SEC` of what it
  asked for, asks once more. The window is wide on purpose: playback has moved
  on by however long it took to start, and this is telling a seek that landed
  from one that vanished, not measuring anything.
- **It resumes like anything else, and the existing rule is why.** A
  broadcast's position means the same thing a recording's does — this far in
  from the start of the stream — so pausing 20 minutes back and refreshing
  returns you to the pause rather than to the edge. No special case: watching at
  the edge puts the play head *at* the stored end, which is precisely what the
  near-the-end rule declines to resume from, and a live player given no seek
  opens where it always does. Paused well behind, the gap is wide and the resume
  runs. One rule, both answers.
- **What live must never do is finish the video.** At the edge the play head is
  at the "end" by definition, so the ordinary 90% test would mark a stream
  watched ten seconds after you joined it. The report carries `live: true` and
  the backend keeps `watched` off (see `routers/history.py`); once the stream has
  aired, the same id reports as a recording and the flag is decided normally.

### Up next (`/api/feed/next/:id`)

When a video ends, a card over the player offers the same channel's next video
**forward in time**. Forward, not "most popular next": that's the order YouTube's
own up-next never offers, and it's the one that lets you work through a channel.
On the channel's newest video there's nothing ahead and no card. Clicking it
dispatches the same `app:watch` event a card's plain-click sends, so the overlay
swaps video exactly as if you'd clicked it in the feed. It never autoplays.

- **Fetched on arrival, not at the end**, so the card is already in hand the
  moment the video finishes instead of appearing a beat afterwards.
- **The end is polled**, not taken from an event: `getPlayerState() === 0` every
  500ms. The embed and a downloaded file answer through the same `PlayerApi`, so
  one code path covers both and nothing here needs to know which it's holding.
- **A running A–B loop suppresses it.** The loop reaches the end deliberately,
  every lap; being handed the next video each time would be the opposite of what
  the loop is for.
- **Playing again takes the card away** and re-arms the dismissal, so a replay or
  a seek back into the video gets it again at the next ending.
- **It follows the channel page's filters.** That page stays mounted behind the
  overlay, so its filters are still the ones in force — pick a topic, a window,
  or "unwatched", and the chain stays inside the list you were actually browsing.
  `App` builds them into a query string (`watchNextFilter`) and passes it as
  `nextFilter`; every other surface sends nothing and gets the plain
  next-in-time. The filters narrow **which** videos are eligible, never the
  order — which is why `sort` is deliberately not among them.
- **The same suggestion is a button in the control bar**, where YouTube puts it:
  right after play/pause (`nextControl`, which `LocalControls` only places — the
  page owns it, because only the page knows what comes next). Hovering it shows
  the very card you'd otherwise have waited for, anchored above the bar and
  `pointer-events-none` so it can hang over the video without ever swallowing a
  click meant for the player. One request feeds both, so the button costs
  nothing extra, and it's absent when there's nothing ahead — a button that
  can't go anywhere is worse than no button. Only in **our** bar: without the
  extension the embed keeps YouTube's controls, and there's nowhere to put it.

### Ask (`AskPanel.tsx`)

A conversation about the video, answered from its own transcript (the backend
half is `routers/ask.py`). Reached from the `…` menu as **Ask AI**, under the
sparkle every product uses for "a model did this" — a speech bubble would read
as chat with a person, and the point is that it isn't one. It shares the
right-hand panel with the transcript —
**one slot, two tabs** — because they are two ways of reading the same thing and
the page should not have two shapes for that. Opening either is a press in the
`…` menu; the tab strip switches between them and closes the slot.

Four things it does that are worth knowing before changing it:

- **It streams.** The reply arrives as server-sent events, one JSON frame per
  `data:` line, read off `res.body.getReader()` — `apiFetch` returns a real
  `Response`, so nothing there needed changing. A network chunk is not a whole
  frame, so the tail of the buffer is held back until its blank line arrives.
  This is the whole reason the endpoint isn't an ordinary JSON POST: the useful
  measurement is when the FIRST word lands, not the last.
- **Answers are Markdown** (`lib/markdown.tsx`) — headings, bullets, bold, one
  level of nesting. A summary of a 40-minute video is a list of sections, and
  rendering it as prose was the difference between "readable at a glance" and a
  paragraph nobody finishes. Hand-rolled rather than a dependency for one
  reason: the leaves go through `linkify`, so a timestamp inside a bullet is
  still a seek button. A library would need a custom text renderer wired in to
  manage that, at which point only the parse is being borrowed.
- **Citations are not parsed separately.** Answers write timestamps as plain
  `[12:34]` and land in the same `linkify` the description and comments use. One
  behaviour for every timestamp on the page, and no second parser to keep in
  step.
- **A question that never reached the model goes back in the box.** The backend
  saves nothing before the first token, so leaving the question in the thread
  would show a turn that a reload wouldn't. A partial answer is the opposite
  case: both sides keep what arrived.
- **The play head rides along.** Each question carries `at`, which only matters
  on a video too long to fit in one prompt — there the transcript is read around
  where you are standing, and the panel says which span that was. It tells the
  *model* nothing — only which bytes it is handed.
- **The two openers are named for how much comes back** — *Short summary* and
  *Long summary* — because that is the only way they differ and the only thing
  worth choosing between. It is also what decides the wait (a few seconds against
  half a minute, since the whole cost of an answer is how much of it there is to
  write), but the wait is a consequence, not the choice. They used to be
  "Summarise this video" and "What are the key points?", which is the same
  request twice and gave the same answer twice.

The `…` entry is gated on the video having captions, the same gate the transcript
uses and for the same reason: the answers are read off that track.

### A summary you walk away from (`summaryStore.ts`, `NotificationBell.tsx`)

Both summaries the panel offers — **Short** and **Long**, named for how much
comes back, the same naming and the same two questions — asked for from any
card's `…` menu and written while you carry on. The card labels itself in the corner where the
*Watched* badge lives — **Summarising**, then **Summarised**, or **Summary
failed** — and the bell says when it landed.

- **The status is a global store, not a prop.** The label belongs to the *card*,
  and cards are rendered by eight different pages; threading `summaryStatus`
  through every one of them to reach one badge is a worse trade than a module the
  card reads directly. Same `useSyncExternalStore` shape as `toastStore`.
- **Polling exists only while something is running.** A finished library is a
  static map, and asking the server about it on a timer would be traffic that
  cannot change its answer. The bell polls slowly on its own (a minute) purely as
  the fallback for a job started in another tab — the real signal is
  `summaryStore` calling `refreshNotifications()` the moment a job it was
  watching flips to done.
- **Both entries stay offered, including after a summary exists.** The other
  length is still worth asking for, and a menu that collapsed to "Summarise
  again" would hide it. While one is running both are disabled, and the spinner
  sits on the length actually running — which is what the job row's `length` is
  for.
- **The click writes the label, not the round trip.** `startSummary` marks the
  video running before the request goes out and lets the server's answer
  overwrite it, so the badge appears on the press. A refusal takes the label back
  off.
- **Rows about a video show its cover.** A thumbnail identifies which video a
  row is about faster than the title beside it does, which is the whole job of a
  list you scan. It comes down on the row itself rather than being looked up, so
  it survives the video leaving the library; a row without one — another `kind`,
  or one written before covers existed — falls back to the kind's icon, and a
  cover that fails to load hides itself rather than leaving a broken frame.
- **A notification is not a toast.** `Toaster` is for the request you just made;
  these are rows on the server that outlive the tab, and by construction the
  person who asked is somewhere else by the time one arrives. Opening the bell
  reads all of them — the badge means *new since you looked*, and there is
  nothing to do with a row but read it. Clicking a summary row dispatches
  `app:open-video` with `panel: 'ask'`, which is the one path into the watch
  overlay that has only an id (`WatchPage` fetches the rest, exactly as on a cold
  load) and the one that opens a side panel that isn't closed.

## Undo (`lib/undo.ts`, `hooks/toastStore.ts`)

Removing a video from History, from a playlist, from Imported, or deleting a
download used to be one click and gone. Each is still one click — and then a
toast says what happened and offers to take it back.

- **Do it, then offer to undo it** — rather than pausing before doing it. A
  pause would have to survive closing the tab, and it would make every
  deliberate deletion feel slow in order to spare the occasional accidental one.
  So the row really is deleted when the toast appears, and Undo is a second
  action that reverses the first.
- **The server hands back a receipt.** Each `DELETE` answers with `removed` —
  the row exactly as the page was rendering it — and undoing posts that receipt
  to a restore. That's what makes the row come back *identical*: a history row
  keeps its resume point, its "Watched" badge and its place in the list, and a
  playlist item goes back to its position rather than to the top. Re-reporting
  progress or re-adding the video would produce something subtly different
  every time, which is the kind of undo that costs more trust than it earns.
- **No receipt, no offer.** Removing something that wasn't there answers
  `removed: null`, and nothing is pushed — an Undo button that would put a blank
  row on the page is worse than no button.
- **The offer expires in ten seconds**, sooner than an error toast's fifteen: an
  undo you come back to a minute later is an undo for a screen you have left.
  It survives navigating within the app, because the restore is a call rather
  than a piece of page state.
- **The one that isn't a restore** is a deleted download: the file is off the
  disk, so taking it back fetches it again. Worth offering anyway — what the
  click saves is finding the video again, and the card says *Downloading* so
  nobody is misled about what's happening.
- **Undo has its own button.** Clicking the message dismisses the toast, and a
  misclick that threw the undo away would be a poor thing to do with a toast
  that exists to catch misclicks.

What is deliberately *not* undoable: hiding a channel (already reversible, and
visibly — the sidebar has a switch for it) and deleting a channel or a playlist,
which take their videos with them and want a confirmation rather than a
ten-second window.

### Comments (`Comments.tsx`)

Under the description, in the **left** column — so an open transcript is still
the only thing that changes this pane's shape.

Everything about it follows one rule: **nothing is fetched until you open it.**
No hover prefetch, no warm-up while the video plays, and no remembered "open"
state carried to the next video — that last one is the subtle way this would
break its own rule, since a remembered preference would fetch on every video you
opened afterwards. A new video starts closed and drops what it held. Reopening
the same one inside half an hour is instant anyway (the backend's cache).

The reason is cost: comments come from yt-dlp walking YouTube's own pages rather
than the Data API — free of quota, but ~2.2s. Replies cost ~15s, because YouTube
serves them a thread at a time, so they're a **second walk behind the first**:
the comments appear at ~2s and are readable straight away, and the reply counts
fold themselves in when the deeper walk lands (a quiet "loading replies…" next
to the sort pills says why they're late). Opening the panel is the one ask —
a button for the second half would be asking the reader about our fetch
strategy. Switching sort afterwards keeps the depth already paid for, in a
single request.

Three things can be in flight at once — both walks and a sort change — and they
finish out of order, so a `turn` counter marks which request is current and
stale answers are dropped. That's also what stops a walk started on one video
from landing in the next one's panel.

**Replies chain, and are drawn nested.** A reply can answer another reply — four
levels deep in an ordinary thread — and each level is drawn a step further in
with a rule down the left, the way YouTube draws it. The indent stops after
`MAX_INDENT` levels and only the rule continues, so a long argument can't walk
itself off the right-hand side into a column two words wide.

One toggle governs a whole thread, and its count is **every** reply beneath the
comment rather than only the direct ones — that's what "12 replies" means to
someone deciding whether to open it. Nested replies carry no toggle of their
own: the thread is already open, so its shape is simply shown.

Timestamps in comments are seek buttons, via the same `linkify` the description
uses (moved to `lib/richText.tsx` when this arrived, so both can share it).
"Skip to 12:40" is written on the assumption that whoever reads it is sitting in
front of the player — here they are.

**Translate.** A comment in another language than the translate target gets a
**Translate** button beside "Read more", the way YouTube's own comments do.
The target is the `translate_lang` setting (English, 繁體中文, 日本語, 한국어,
ไทย or Tiếng Việt), or the app language while that's left on "Same as the app"
(`translateTarget()` in `lib/i18n.ts`).
"Another language" is `looksWrittenIn`: the share of the comment in the
target's script, counting a CJK or Thai character and a word of anything else
as one unit each, so a Chinese comment about an iPhone is still Chinese.
Simplified Chinese counts as Chinese; Japanese needs some kana, since kanji
alone reads as Chinese; Vietnamese is told from English by the letters only it
has (ơ, ư, đ, ạ…), which turn up in most of its words; a comment with no letters
offers nothing. The press posts that one comment to
`/api/feed/comments-translate` with the target; the translation replaces the
text in place (timestamps in it still seek), and the button becomes **Show
original**, which toggles without asking again. A failure says so under the
comment and the same button tries again. Nothing is translated until you press:
most of a section is never read.

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
scrub preview. It carries play/pause, mute + a volume slider with the level beside it as a
percentage (the shared, persisted store, so a level set here follows you to the
next video; the slider stays collapsed until hovered, but the percentage is
always on the bar), a **boost** group beside it (below), a **speed** menu
(below), the clock,
the CC button, pin and fullscreen — everything with a keyboard equivalent
(`k`, `m`, `c`, `p`, `f`, `,`/`.`). It shows while the pointer is over the player or while paused,
and mirrors the element's own events rather than polling, so a keyboard seek or
the resume jump moves it too.

**Focus mode** (`hooks/focusMode.ts`) takes the bar's three ways up and keeps
one. Ordinarily it rises for the pointer moving over the video, for the video not
playing, and — in `WatchPage` — for any shortcut key, since a keypress is
evidence you're there and in fullscreen it's the only evidence there is. That
last rule is what makes the bar keep painting itself back over a video you're
steering by keyboard: every `k`, every arrow. In focus mode only the pointer
raises it, pausing included.

- **The overlays that answer a keypress are untouched** — the volume HUD, the
  bookmark flash, the captions. Those *are* the feedback for what you pressed;
  hiding them would leave the key doing nothing visible at all. It's the bar
  that stays down.
- **The cursor is the way back in**, which is also how you reach the button to
  turn it off again. Turning it ON with the pointer on the video doesn't yank
  the bar out from under the click that did it, for the same reason.
- **Persisted, and read through a ref as well as a hook.** It's about how you
  watch rather than what, so it follows you to the next video like the volume
  does; the key handler is bound once, so it would otherwise keep answering with
  whatever the setting was when the page opened.

The **volume boost** (`hooks/audioBoost.ts`) is the second group in that row,
and deliberately not the same thing as the first. The shared volume is one level
for everything you watch and stops at 100% — the loudest the file is. Some videos
are simply mixed quiet, and turning the shared level up to compensate makes the
*next* video shout. So the boost belongs to the video instead: 1× to 8× in
quarter steps, multiplying the element's own volume, **reset whenever `src`
changes**. The chain ends in a **limiter** (a `DynamicsCompressorNode` at −6dB,
12:1, 3ms attack): plain gain on a track that already peaks near full scale
clips rather than gets louder, so past about 4× the extra range is only worth
having if the peaks are held down while the quiet parts keep climbing. The button toggles 1× ↔ 2×; the slider is the fine control. The
multiplier shows only while it's above 1×, since at 1× it would be a number that
never moves next to one that does.

- **It needs the audio**, so the page can only do this where we serve the file — a
  download or a local folder. The embed is a cross-origin iframe: its audio is
  not ours to route, and nothing in the IFrame API amplifies.
- **Over the embed the same control works through the extension** — `useRemoteBoost`
  pings the iframe, and `extension/embed-boost.js`, which runs *inside* it, applies
  the gain there and reports back. The control appears only once that ping is
  answered, so without the extension there's no button rather than a dead one, and
  a `result` saying the frame couldn't do it puts the slider back to 1×. The
  protocol is in [extension/README.md](../extension/README.md).
- **The WebAudio graph is built lazily**, on the first raise above 1×.
  `createMediaElementSource` is a one-way door — from then on the element's sound
  reaches the speakers only through our graph — so a context that couldn't start
  would mean silence, not a missing boost. That first raise is a click, which is
  the gesture that lets the context run. Untouched, the ordinary path never goes
  near WebAudio.
- **The graph belongs to the element, not the video.** Moving to the next video
  reuses it (an element can only be tapped once) and just sets the gain back to 1.

**Playback speed** is the last of the per-video controls in that row, and the one
thing `controls=0` takes away from the embed that we hand straight back. It ships
with YouTube's own eight rates (0.25× to 2× in quarter steps) and is a **setting**
(`playback_speeds`, `lib/playbackSpeeds.ts`) — someone who wants 0.1 steps wants
them here. A menu rather than a click-through cycle: too many to step past one at
a time, and the button has to say which one you're on anyway.

- **One list does both jobs** — the menu and the keyboard's step. A menu that
  couldn't reach the speed the keys just set would be lying about where you are.
  Normal speed is forced into any list you save: it's where every video starts
  and the one rate you must be able to get back to.
- **The player is the source of truth**, not this component. The slower/faster
  keys change the rate on the player directly — from `WatchPage`'s handler over the embed, from
  `LocalWatchPage`'s on a local file — and the bar reads it back on the same poll
  that carries the clock, so the label follows a speed it never set. A second
  copy of the number here is the one that would go stale.
- **It resets with the player**, since nothing persists it: a new video plays at
  1×, which is what a speed chosen for one video's narrator should do.
- **Not on a broadcast.** Live playback is the edge, so there is nothing to speed
  up, and slowing it down only walks you backwards off it. The button is absent
  there rather than present and inert.
- **Bare keys, unlike YouTube's.** It puts speed on shift+`,` and shift+`.`;
  nothing else here is a chord, and holding shift to nudge the speed is a key too
  many. `<`/`>` still work — it's the same key, and arriving on it with shift
  still down after a capital is a slip rather than a different intention.
- `nextSpeed()` steps from the *nearest* offered speed rather than from an index
  — a `<video>` takes any number at all, and the list can change under a video
  that's already playing — and stops at both ends instead of wrapping, because a
  keypress that drops 2× to 0.25× is never what was meant.

**Shortcuts are a setting** (`shortcuts`, `lib/shortcuts.ts`). `ACTIONS` is the
one table of what the player can be told to do, the key each ships on and the
label the settings page shows; `WatchPage`, `LocalWatchPage` and `PlayerMarks`
all ask `actionFor(e.key)` rather than comparing letters, so rebinding a key is
a stored override instead of an edit in three files.

- **Only what you moved is stored**, like `page_defaults` — put a row back and it
  follows the built-in default again, including if that default moves later.
- **A key can be taken away entirely** (`''`), which is a third state and stored
  as its own: a shortcut you kept hitting by accident is one you want gone, and
  "off" is not the answer "back on its default" gives. An unbound action answers
  to nothing, takes no key from anyone (so several may have none), and shows a
  dash where a tooltip would name its key — `Mute (—)` rather than `Mute ()`.
  Its button still works; only the key is gone.
- **`space` and `Escape` are not in the table.** Every player on earth plays and
  pauses on space (the handlers take it by `e.code`, so it works whatever
  `playPause` is bound to), and Escape closes what's open. The editor refuses to
  record either.
- **A shifted key is the key under it.** `K` is `k`, and `<`/`>`/`{`/`}`/`|` are
  `,`/`.`/`[`/`]`/`\` — you arrive there having just typed a capital, which is a
  slip rather than a different intention. Normalised on the way *in* as well, so
  a shortcut can only ever be stored unshifted.
- **The editor rebinds by listening, not by typing a key's name** — nobody knows
  whether it's `ArrowUp`, `Up` or `↑`. It listens in the **capture** phase so the
  key it's recording doesn't also do its job on the way past, and it refuses a
  key another action is on rather than stealing it silently, naming the action
  that has it.
- **Tooltips read the binding**, not a hard-coded letter: `Play ({key})` and the
  rest interpolate `shortcutLabel(id)`, so a rebound key can't leave the bar
  telling you to press the old one.

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

Against the embed without the extension, these float over the player instead —
its control bar is inside the iframe, out of reach — so the caption button, the
two marks buttons, open-on-YouTube and the pin each render in two placements
from one definition (`captionControl` / `marksControls` / `youtubeButton` /
`pinButton`).

> **Trap:** the hover preview must be destroyed *before* the watch player is
> created. Both are YouTube players for the same video, and two live players for
> one video wedge the new one on a buffering spinner (unmuted icon, no sound).
> `VideoCard.openVideo()` therefore calls `teardownPlayer()` synchronously rather
> than pausing and letting the ~600ms idle timer clean up. This looked exactly
> like an autoplay-policy bug and wasn't.

---

## Phone and tablet

The app is built for a desktop with a keyboard, and it stays that way — the
shortcuts are the point of it. What follows is the smaller promise: that
nothing is *unreachable* without a pointer.

**Navigation.** Below `md` the sidebar becomes a drawer over the page
(`mobileMenuOpen` in `App.tsx`) and a fixed bottom bar appears with the four
most-used destinations. The drawer's own nav list carries all nine, because the
bar can't: Playlists, Imported, Local, History and Settings have no other door.
Picking anything from the drawer closes it; a filter click inside it does not.
`Sidebar.test.tsx` holds that line.

**Leaving a video.** The watch overlay is `z-[60]` — above the sidebar, above
the bottom bar — so a back button in the player's top-left corner is the only
way out that isn't the browser's own (`onClose`, which calls `history.back()`).
`LocalWatchPage` has always had one in the same corner; `WatchPage` now matches
it. It never fades with the rest of the chrome: the way out of a page can't be
something you have to wake the player to find.

**Hover is not a thing a phone has.** Tailwind gates `hover:` — and so
`group-hover:` — behind `@media (hover: hover)`, which makes
`opacity-0 group-hover:opacity-100` a control that is permanently invisible
where there is no pointer. `index.css` declares a `hoverable` variant for the
other half of that pair: `hoverable:opacity-0` hides a control only where
hovering can bring it back, and it simply stays visible everywhere else. The
reveal has to be prefixed too (`hoverable:group-hover:opacity-100`) — a custom
variant is emitted after the built-in ones, so an unprefixed reveal would lose
to the rule that hides it, at equal specificity, on a desktop as well.
`touchReveal.test.ts` enforces both halves across every component.

What that covers today: deleting a playlist, deleting a mark, dismissing a
summary notification, removing a local folder, hiding a channel, and the volume
and audio-boost sliders in our own control bar (`REVEALING_SLIDER`, which is
the shared half of those two — each site still spells out its own group's
reveal, because Tailwind reads the source for literal class names and generates
nothing for one assembled at runtime). Three reveals are deliberately
left alone — the preview's volume slider and scrubber knob, and the up-next
peek — because they live inside a hover preview a phone never opens.

**The viewport.** The shell is `h-dvh`, not `h-screen`: iOS reports `100vh` as
the screen *without* its toolbars, which pushes a fixed bottom bar behind them.
The bar pads itself past the home indicator with
`pb-[env(safe-area-inset-bottom)]`, and `<main>` reserves that padded height.

**The tablet seam.** `md` (768px) is where the sidebar comes back, which leaves
a 768px-wide tablet with ~528px of page. The time window and the sort row
therefore split at `lg`, not `md`: side by side at 768 the slider is narrow
enough that its twelve labels — absolutely positioned by percentage, so they
overlap rather than wrap — run together into a smear. Settings rows stack below
`sm` for the same reason: beside a wide menu, a 375px screen leaves the
description ~130px and six lines tall.

What is *not* fixed, and is the real fork: over the YouTube embed our overlays
wake on pointer movement, so with the extension installed (`controls: 0`, our
bar is the only one) a tap both raises the chrome and toggles play. Answering
that means designing a touch state machine for the player, which is the whole
couch-and-phone question rather than a patch.

## Tests

Component/behavior tests live in `src/test/` and run under Vitest + jsdom
(`npm test`). `src/test/setup.ts` wires up `@testing-library/jest-dom`, plus the
two shims Radix's slider needs to mount at all (below).

| File | Covers |
|------|--------|
| `PlayerMarks.test.tsx` | `b` / `[` / `]` / `\` and the bar's two buttons driving the same actions, the add-toggle tolerance, whether the head is standing on a mark, the loop tick, and how both are drawn — the bookmark's tick, the loop's cuts and its veil |
| `LocalControls.test.tsx` | the `<video>`→`PlayerApi` adapter, scrubbing, volume, driving either source, the scrub popup (its frame, and where it stops at the ends), and the marks in the track — including the **document order** that lets the loop's veil dim the fill without ever dimming the play head or a bookmark |
| `AskPanel.test.tsx` | the streamed answer: frames split across network chunks, Markdown rendered as it lands, a citation that seeks, the play head riding along, what a refused question does to the box, and a reply that stops partway |
| `markdown.test.tsx` | the block parse (headings, both list kinds, nesting, paragraph joining) and — the reason it exists — a timestamp surviving a bullet, a bold run and a sub-item and still seeking |
| `NotificationBell.test.tsx` | the badge and its cap, opening the bell clearing it, the cover and its icon fallback, a summary row opening the video on its Ask panel while a failure row has nowhere to send you, and dismissing one row without touching the rest |
| `summaryStore.test.tsx` | the length reaching the server, the label appearing on the click rather than the round trip, coming back off when the request is refused, and holding its last known value when the server can't be reached — plus the filter's half of the store: the finished ids only, one landing mid-session, and the snapshot identity `useSyncExternalStore` would otherwise re-render forever on |
| `api.test.ts` | the error toast, `quiet` mode, reading the detail off a clone |
| `toastStore.test.tsx`, `audioStore.test.tsx` | the two external stores, incl. cross-tab volume sync and the undo toast: one press only, dismissing without undoing, and expiring sooner than an error |
| `undo.test.tsx` | the four undoable removals: that the server's receipt is what goes back, that a playlist item keeps its place, that a deleted download is fetched again, and that nothing is offered when nothing was removed |
| `touchReveal.test.ts` | that no control is hidden behind a hover a phone can't perform — and that the reveal which brings it back is prefixed to outrank the rule that hides it |
| `time.test.ts`, `local.test.ts` | the clock, resume ratios, size formatting, the fetch helpers |
| `ext.test.ts` | the clean-embed capability: the marker, an unknown version, and that the answer is frozen for the page |
| `storyboard.test.ts` | picking a scrub frame: the walk across a sheet, crossing sheets, clamping, and scaling to a width |
| `quality.test.ts` | the resolution label: the names that say nothing on their own, and the ones that hide it |
| `timeWindow.test.ts` | the time-window ladder: clamping, snapping, and the `age` round-trip |
| `TimeRangeSlider.test.tsx` | the two thumbs, the tick notches and their alignment, clicking a label, and the keyboard |
| `Comments.test.tsx` | that nothing is fetched before the panel opens, that a new video starts closed without fetching, the replies walk following the comments on its own (and failing without disturbing them), a chain of replies nested under one count and one toggle, a timestamp in a comment seeking the player, and disabled vs empty |
| `presets.test.ts` | filter presets: what a page captures, what it trims on the way back in, when a preset counts as the one in force, and an empty watch list counting as a selection where a null one doesn't — and the length buckets, whose empty list is the default and so counts as nothing |
| `ChannelPage.test.tsx` | a channel page confined to a search: the words riding along beside the window and the sort, trimmed (and blank meaning no search at all), the list starting again rather than appending when they change, and an empty result naming both the words and the range; plus the length buckets going to the server, this list being paged |
| `shortcuts.test.ts` | the key table: what a keypress means, a capital and a shifted punctuation key reading as the key under it, an override answering on the new key and no longer the old one, a stored value it can't use dropped rather than shadowing a default, and the conflict the editor asks about — against the draft being edited, not the keys in force |
| `playbackSpeeds.test.ts` | the speed list: what a stored value is tidied into (sorted, de-duplicated, normal speed forced in, capped in length), what the settings field accepts and what it refuses outright, and `nextSpeed` stepping through *your* list from the nearest speed and stopping at both ends |
| `playerSettings.test.tsx` | the two editors: a tidied list saved on blur and on Enter, text that isn't speeds refused instead of salvaged, Escape putting the field back — and, for shortcuts, a key recorded by being pressed, a taken key refused by name, a row put back on its default stored as nothing at all, and space declined |
| `focusMode.test.tsx` | the preference under the bar's button: off until asked for, reaching every reader, written down, and taking the other tab's word for it |
| `VideoCard`, `VideoRow`, `Sidebar`, `TopBar`, `TimeSortControls` | the feed surfaces — including the sidebar's length chips: rendered only where a page can use them, which one was clicked, and "select all" turning on only what is off; and that the sidebar offers all nine destinations at every width, since the phone's bottom bar only holds four |
| `appHelpers.test.ts` | the pure helpers `App.tsx` exports: the window, the sorts, the tag selection and its exclusions, the URL round-trip, `pageFilters` closing the length buckets in Shorts mode but only where that mode governs the list, the three watch statuses — including the two ways of saying "no filter" and the remembered choice a bad storage value falls back from — and the length buckets: each boundary second landing in the longer one, a runtime of 0 landing in none, and both ways of meaning "any length" |

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

### Waiting for the right thing

`PlayerMarks.test.tsx` presses `b` twice in several tests, and what the second
press does depends on whether the first one's POST has come *back*: a saved mark
is deleted on the server, while one still carrying its temporary negative id is
only dropped from view. Both are real behaviours, each with its own test.

Waiting on the request going *out* — `await waitFor(() => expect(posted.length)
.toBe(1))` — doesn't tell them apart. The mock records `posted` inside the call,
so that condition is already true before the id exists; the test then turned on
whether the microtask queue happened to drain first, which under load it didn't,
about one run in three. `markAt()` awaits the save itself, and is what anything
pressing twice should use.

The general form: **wait for the state the next step depends on, not for the
request that will eventually produce it.** A test that waits on the wrong signal
doesn't fail — it quietly tests the other path, and reports that as a pass.
