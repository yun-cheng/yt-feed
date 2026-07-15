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
  'downloads' | 'search' | 'watchlater'`.
- On navigation it calls `history.pushState` with a URL built by `buildPath(...)`;
  a `popstate` listener parses the URL back into state, so **back/forward work**
  and every view is deep-linkable.
- Feed controls (time window, sort, selected tags, videos↔shorts mode) are
  encoded in the URL query string and restored on load — so a filtered feed can
  be bookmarked.
- Data is fetched from `/api/*` into React state (`fetchFeed`, `fetchTags`, …);
  the feed is paged by `offset`/`limit` with a load-more trigger (`loadMoreFeed`).

### Auto-refresh

A visibility-aware timer periodically **re-reads** the feed (`fetchFeed` +
`fetchTags`) to pick up whatever the backend's scheduler last scraped — a plain
data refresh, no scraping on the client.

### Components

```
components/
  Sidebar.tsx / TopBar.tsx        chrome: nav, search box, tag filters
  TimeSortControls.tsx            time-window + sort pills
  VideoCard.tsx                   the card + hover preview (the complex one)
  VideoRow.tsx                    list-row variant
  ChannelPage.tsx / ChannelsPage.tsx
  PlaylistPage.tsx / PlaylistsPage.tsx / SaveToPlaylist.tsx
  DownloadsPage.tsx
  SearchPage.tsx
  WatchPage.tsx                   in-app player (/watch/:id) — full-size embed + metadata
hooks/
  audioStore.ts                   shared, persisted preview VOLUME
```

---

## The hover preview (`VideoCard.tsx`)

The most intricate component. When a card is hovered it lazily creates a
YouTube IFrame player over the thumbnail and drives it directly:

- **Always starts muted.** Muted autoplay is the only kind browsers reliably
  allow — an unmuted autoplay without a fresh gesture just wedges buffering.
- **Click the video to unmute** *that* preview. A real click is the gesture the
  autoplay policy requires, so unmuting an already-playing muted video is
  reliable (no spinner/wedge). A second click opens the video. Buttons, the
  progress bar, the title, and the ⋮ menu keep their own behavior and never
  unmute-or-open. Modifier/middle-clicks open in a new tab natively.
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

## Tests

Component/behavior tests live in `src/test/` and run under Vitest + jsdom
(`npm test`). `src/test/setup.ts` wires up `@testing-library/jest-dom`.
