# Backend — YT Feed

FastAPI service that scrapes your subscribed channels, stores videos in SQLite,
ranks them, and serves a JSON API to the frontend. A background scheduler keeps
the data fresh; a small Meilisearch companion powers search.

---

## Stack

| Concern | Choice |
|---|---|
| Web framework | **FastAPI** (async) on **uvicorn** |
| DB | **SQLite** via **SQLAlchemy 2.0 async** + **aiosqlite** (WAL mode) |
| Config | **pydantic-settings** (`app/config.py`, `.env`) |
| YouTube scraping | **yt-dlp** (flat mode for listings, full extract for storyboards/captions) |
| YouTube stats | **YouTube Data API v3** (optional OAuth token) with a yt-dlp fallback |
| Search | **Meilisearch** (separate process on `:7700`) |

Dependencies: [`requirements.txt`](requirements.txt).

---

## Run

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

The DB and downloads live under `../data/` (created on first run). Search is
optional — if Meilisearch isn't running, search just returns nothing and the
rest of the app is unaffected. To enable it:

```bash
meilisearch --db-path ../data/meili --http-addr 127.0.0.1:7700 --no-analytics
```

All three services (frontend, backend, meilisearch) are also defined in
[`../.claude/launch.json`](../.claude/launch.json).

---

## Layout

```
app/
  main.py          FastAPI app, lifespan, the scan SCHEDULER, /api/refresh
  config.py        Settings (paths, OAuth, Meili) via pydantic-settings
  database.py      Async engine + session factory, schema create, tiny migrations
  models.py        SQLAlchemy tables (see "Data model")

  cron_update.py   run_update(): the actual channel-scan job (Phases 1–4)
  fetcher.py       yt-dlp wrappers (channel listings, video details)
  youtube_api.py   YouTube Data API v3 batch stats (+ token handling)
  ranking.py       score = views / hours-since-published; time-window buckets
  categorizer.py   keyword → category/tag rules (from config/*.yaml)
  search_index.py  Meilisearch push + query (best-effort)
  auth_google.py   OAuth login flow (only needed to import subscriptions)

  routers/         one file per resource, all mounted under /api
    feed.py        the main feed, storyboards, captions, statistics
    channels.py    channel pages
    search.py      proxies to search_index
    tags.py        channel tag CRUD + per-tag counts
    watch_later.py / playlists.py / downloads.py / subscriptions.py

config/            categories.yaml, tags.yaml, subscriptions.yaml, oauth token
scripts/           one-off maintenance scripts (backfills, fixes)
```

Everything is wired together in `main.py`, which mounts each router under
`/api` and starts the scheduler in the app **lifespan**.

---

## How data flows

```
                 (every 15 min, backend-driven)
  scheduler ──► run_update() ──► yt-dlp scrape ──► upsert into SQLite
                                                        │
  browser ──► GET /api/feed ──► rank_videos() ◄─────────┘
                    │
                    └─► group by category → JSON → frontend
```

1. **Scan** (`cron_update.run_update`) runs on the scheduler (below) and writes
   fresh videos/stats into SQLite. It does **not** happen on request.
2. **Serve** (`routers/feed.py`) reads videos from SQLite, ranks them with
   `ranking.rank_videos`, groups them into categories, and returns JSON. Reads
   are cheap and never trigger a scrape.

Reads never trigger a scrape — see "Concurrency notes."

---

## Ranking & feed shaping (`ranking.py`)

This is the heart of the project. The feed answers *"what's worth watching from
my subs right now,"* which is more than reverse-chronological. `rank_videos()`
does three things: filter to a time window, score, and sort.

### Time windows are discrete buckets — with two modes

Each window (`1d 3d 1w 2w 1m 3m 6m 1y`) maps to a `(lower, upper)` age range
(`WINDOW_RANGES`). The `time_mode` decides how the range is read:

- **wide** (default) — accumulated from now: `3d` = everything **0–3 days** old.
- **narrow** — the exclusive bucket: `3d` = only **1–3 days** old.

Narrow mode lets you step through "this week, but not today" without re-seeing
the newer videos you already scanned.

### Hot score, with a burn-in

```
score = views / (hours_since_published + 12)
```

The **12-hour burn-in** (`HOT_HOUR_OFFSET`) is the key trick. Without it, a video
posted minutes ago divides by ~0.1h, so a handful of views explodes to the top.
Adding 12h to the denominator suppresses that early-velocity noise until enough
time (and views) accrue to trust the rate.

### Sort modes

`score` (hot, above), `views`, `likes`, `newest` / `oldest`, and `like%`.

`like%` (engagement rate) is **not** a raw `likes/views` — that would let a video
with 3 views and 2 likes claim "66%". Instead each ratio is pulled toward the
feed's average rate via Bayesian shrinkage, weighted by 1500 "pseudo-views"
(`LIKE_PCT_PSEUDO_VIEWS`):

```
(likes + prior·C) / (views + C)      # C = 1500, prior = feed's avg like rate
```

Small-sample videos sit near the prior; only videos with views ≫ 1500 are
trusted at their raw ratio.

### Other shaping

- **Member-only videos are dropped** — a row with 0 views but non-zero likes is
  gated content, filtered out of every window.
- **Categories** — the feed is grouped into topic sections; a channel's category
  comes from keyword rules in `config/categories.yaml` (`categorizer.py`).
- **Stats freshness** — the scanner refreshes view/like counts on an age-based
  schedule (newer videos more often), so a hot score reflects recent velocity
  rather than a stale snapshot.

---

## The background scanner

`main.py`'s lifespan starts `_scheduler_loop()`: one scan ~30s after startup,
then every `SCAN_INTERVAL_SECONDS` (default **15 min**, env-overridable). A
`_refreshing` flag means scheduler ticks and manual `POST /api/refresh` calls
never overlap.

`run_update()` has four phases:

1. **Scan** — for each channel, yt-dlp *flat mode* over `/videos` and `/shorts`
   to collect video IDs and upsert rows (fast, no JS challenges).
2. **New-video stats** — batch-fetch real view/like counts for newly-seen
   videos via the YouTube Data API (yt-dlp fallback if the token is dead).
3. **Stale-video refresh** — re-fetch stats for recent videos on an age-based
   schedule (newer videos refresh more often).
4. **Reindex** — push updated titles/stats into Meilisearch.

yt-dlp is configured to **fail fast** (`fetcher.py`: `socket_timeout` 10,
`retries` 1) — its default ~10× retries over 130+ channels used to exhaust the
process's sockets.

---

## Hover-preview data (`routers/feed.py`)

The frontend's hover preview pulls two extras from the backend, both served
through the bounded/de-duplicated/negatively-cached pool (see Concurrency notes):

- **Storyboards** (`/api/feed/storyboard/{id}`) — YouTube's sprite-sheet preview
  thumbnails, so the scrub bar can show a frame at the hovered timestamp.
- **Captions** (`/api/feed/captions/{id}`) — the timed transcript, which the
  frontend renders itself (YouTube's embed captions are tiny/unreliable in a
  cropped embed). `_fetch_captions` deliberately serves the video's **native
  language**: it prefers human-uploaded subtitles, then the original ASR track,
  and skips machine-*translated* tracks (which carry `tlang=` in their URL).

## Offline downloads (`routers/downloads.py`)

The Downloads library fetches videos to disk with yt-dlp and serves the file
back via `FileResponse`. The frontend then plays the **local file** in the
preview card (a `<video>` element behind the same player interface) instead of
the YouTube embed — so downloaded videos preview and play fully offline.

---

## Data model (`models.py`)

| Table | Purpose |
|---|---|
| `channels` | subscribed channels (id, title, `last_video_fetched`) |
| `videos` | scraped videos (stats, `published_at`, `is_short`, `last_updated`) |
| `tags` / `channel_tags` | topic tags and channel↔tag assignments |
| `watch_later` | saved-for-later videos (server-side, syncs across devices) |
| `playlists` / `playlist_items` | user playlists |
| `downloads` | videos downloaded to disk for offline viewing |
| `hidden_channels` | channels hidden from the home feed (excluded in the feed query) |

`watch_later`, `playlist_items`, and `downloads` each store a **metadata
snapshot** of the video so a card still renders even after the video ages out
of the feed window. Schema is created by `Base.metadata.create_all`; new columns
are added by the tiny additive-migration list in `database.py`.

---

## Config (`config/`)

- **`subscriptions.yaml`** — the channels to follow (imported via the OAuth flow
  in `auth_google.py`, or edited by hand).
- **`categories.yaml`** — keyword rules that sort each channel into **one** feed
  category (the section headers, e.g. 科技 / 音樂). `categorizer.py` picks the
  best-matching category from the channel's title/description.
- **`tags.yaml`** — tag definitions. A channel can carry **many** tags
  (`channel_tags` table); auto-assigned by keyword rules in `routers/tags.py`.
- **`youtube_oauth_token.json`** — the Data API token refreshed by the in-app
  "Re-authenticate" link. Stats fall back to yt-dlp if it's missing/expired, so
  OAuth is **optional**.

> **Categories vs. tags** are independent systems: categories **group** the feed
> into sections (one per channel); tags **filter** it via the sidebar chips
> (many per channel).

---

## Concurrency notes (the non-obvious bits)

These are the design decisions most likely to bite if you touch them:

- **The scan runs in its own thread + event loop** (`threading.Thread` →
  `asyncio.run(run_update())`) so its blocking yt-dlp work never stalls the
  request-serving loop.
- **The DB engine uses `NullPool`** (`database.py`). An async SQLAlchemy/aiosqlite
  connection is bound to the loop that created it; sharing a pooled connection
  across the main loop and the scan thread's loop hangs forever (a Future the
  wrong loop resolves) and wedges the server. NullPool gives every session its
  own connection on its own loop. **WAL mode** lets the scan's writes and the
  feed's reads proceed concurrently. A 30s busy timeout absorbs brief write-locks.
- **Storyboard/caption fetches use a bounded pool** (`routers/feed.py`,
  `_preview_pool`, 6 workers) with in-flight de-duplication and negative caching,
  so a burst of hover-previews can't saturate the executor, re-fetch the same
  video N times, or re-hit caption-less videos on every hover.

---

## Key endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/feed` | ranked feed grouped by category (query: window, sort, tags…) |
| GET | `/api/feed/storyboard/{id}` | hover-scrubbing storyboard frames |
| GET | `/api/feed/captions/{id}` | timed caption cues (rendered by the frontend) |
| GET | `/api/feed/video/{id}` | one video's metadata (for the in-app watch page / deep links) |
| GET | `/api/channels/{id}` | a channel's videos |
| GET | `/api/search?q=` | typo-tolerant search (channels + videos) |
| GET/POST | `/api/tags`, `/api/watch-later`, `/api/playlists`, `/api/downloads` | resource CRUD |
| GET/POST/DELETE | `/api/hidden-channels` | list / hide / un-hide channels from home |
| POST | `/api/refresh` | manually trigger a scan (normally the scheduler handles it) |
| GET | `/api/refresh/status` | `{running: bool}` |
| GET | `/api/health` | liveness |

Interactive docs at `http://localhost:8000/docs` when the server is running.

---

## Tests & maintenance

- There are **no automated backend tests** yet (the frontend has a Vitest
  suite). Smoke-check with `/api/health` and `/api/feed`, and `/docs` for the
  full surface.
- `scripts/` holds one-off maintenance scripts (stat backfills, date/count
  fixes, subscription import) — run ad hoc, not part of the app.
