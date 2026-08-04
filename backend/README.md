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
  config.py        Settings (paths, OAuth, Meili, OpenRouter) via pydantic-settings
  database.py      Async engine + session factory, schema create, tiny migrations
  models.py        SQLAlchemy tables (see "Data model")

  cron_update.py   run_update(): the actual channel-scan job (Phases 1–4)
  fetcher.py       yt-dlp wrappers (channel listings, video details)
  youtube_api.py   YouTube Data API v3 batch stats (+ token handling)
  ranking.py       score = views / hours-since-published; time-window buckets
  categorizer.py   legacy keyword → feed-category rules (config/categories.yaml)
  llm.py           OpenRouter chat client, shared by AI features
  video_labels.py  LLM per-video topic labeling (see "Video topics")
  search_index.py  Meilisearch push + query (best-effort)
  auth_google.py   OAuth login flow (only needed to import subscriptions)

  routers/         one file per resource, all mounted under /api
    feed.py        the main feed, storyboards, captions + AI translation
    channels.py    channel pages + video-topic chips/filtering (see "Video topics")
    search.py      proxies to search_index
    tags.py        LLM channel tagging + taxonomy, tag editor (see "Channel tagging")
    history.py     watch positions — resume, the card's progress bar, History
    imported.py    videos added by pasting a YouTube link (metadata via yt-dlp)
    local.py       local folders: scan a directory, serve its files, remember positions
    watch_later.py / playlists.py / downloads.py / subscriptions.py

config/            categories.yaml, subscriptions.yaml, oauth token
.env               secrets (OPENROUTER_API_KEY); gitignored
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

`main.py`'s lifespan starts two loops. `_scheduler_loop()` scans for new videos:
once ~30s after startup, then every `SCAN_INTERVAL_SECONDS` (default **15 min**,
env-overridable). A `_refreshing` flag means scheduler ticks and manual
`POST /api/refresh` calls never overlap. `_resync_loop()` is the daily
subscription reconcile (below).

`run_update()` has four phases:

1. **Scan** — for each channel, yt-dlp *flat mode* over `/videos` and `/shorts`
   to collect video IDs and upsert rows (fast, no JS challenges). On a channel's
   **first** scan (`last_video_fetched is None`) it also runs a **1-year backfill**
   (see below) so high-volume channels aren't stuck with just the latest ~50.
2. **New-video stats** — batch-fetch real view/like counts for newly-seen
   videos via the YouTube Data API (yt-dlp fallback if the token is dead).
3. **Stale-video refresh** — re-fetch stats for recent videos on an age-based
   schedule (newer videos refresh more often).
4. **Reindex** — push updated titles/stats into Meilisearch.

yt-dlp is configured to **fail fast** (`fetcher.py`: `socket_timeout` 10,
`retries` 1) — its default ~10× retries over 130+ channels used to exhaust the
process's sockets.

The scanner only ever walks channels **already in the DB** — it never re-reads
your YouTube subscription list. That's a separate, much slower loop:

### The daily subscription resync

`_resync_loop()` runs `POST /api/subscriptions/resync`'s logic **once a day**
(`RESYNC_INTERVAL_SECONDS`), so subscribes and unsubscribes land on their own.
It's daily rather than per-scan because it costs an OAuth round-trip and its
prune is destructive — an unsubscribed channel's videos go with it.

Four things make it safe to run unattended:

- **The clock is `subscriptions.yaml`'s mtime**, which a successful resync
  rewrites — not a sleep timer. A sleep timer would either re-run the prune
  minutes after every restart, or push the next resync a full day out on a
  machine that reboots daily.
- **It never raises.** A dead token or an API hiccup logs and backs off
  (`RESYNC_RETRY_SECONDS`, default 1h) instead of killing the task; if there's
  no OAuth token at all it skips without even calling YouTube.
- **It holds the scan guard** (`_refreshing`) for the whole reconcile, so a
  scheduler tick can't start a scan halfway through the prune — and it won't
  start while a scan is already running.
- **It dry-runs first and refuses a big prune.** More than `RESYNC_MAX_PRUNE`
  (default 5) channels going at once is likelier a truncated response from
  YouTube than a real unsubscribe spree, and each one takes a year of videos
  with it. It aborts loudly and leaves the call to the manual endpoint.

What it deliberately does **not** touch: `last_video_fetched`, `llm_labels`,
`video_label_vocab`, or the tags of channels you're still subscribed to.
`import_subscriptions` updates existing rows field-by-field rather than
replacing them, so the daily run never re-triggers a channel's 1-year backfill
and never re-spends LLM tokens — only genuinely new channels get scanned from
scratch and auto-tagged.

The endpoint remains for forcing one by hand, and `?dry_run=true` still previews.

### History backfill — date-aware, so a full year is guaranteed

The flat scan is **count-bounded** (newest ~50/tab) and yt-dlp flat mode returns
no dates, so "latest 50" can be as little as a few days for a firehose channel.
To keep **a year of history**, `backfill_channel()` instead pages the channel's
uploads playlist via the **YouTube Data API** (`fetch_uploads_since`), which is
date-native — it stops exactly at the cutoff and reliably covers even ~20-uploads/day
channels. It only inserts videos not already stored (idempotent); Shorts are
flagged via the `/shorts` tab. It runs automatically on a channel's first scan
(1-year window) and on demand via `POST /api/channels/{id}/backfill?years=N`
(`years<=0` = entire history) — the primitive a "load older videos" UI can call.
No retention prune: older videos are kept once fetched.

---

## On-demand yt-dlp data (`routers/feed.py`)

Three per-video extras are scraped when asked for rather than stored, all served
through the bounded/de-duplicated/negatively-cached pool (see Concurrency notes):

- **Storyboards** (`/api/feed/storyboard/{id}`) — YouTube's sprite-sheet preview
  thumbnails, so the scrub bar can show a frame at the hovered timestamp.
- **Captions** (`/api/feed/captions/{id}`) — the timed transcript, which the
  frontend renders itself (the hover preview and the watch page both style their
  own captions). With no `lang`, `_fetch_captions` serves the video's **native
  language**: it prefers human-uploaded subtitles, then the original ASR track,
  and skips machine-*translated* tracks (which carry `tlang=` in their URL). Pass
  `?lang=en|zh|ja|ko` and it honors that choice instead — uploaded sub → original
  ASR → auto-*translated* track — and reports the resolved base code back as
  `lang`. Each cue returns the joined `text` plus a `words` array — per-segment
  text with `tOffsetMs`-derived absolute times — so the watch page can reveal auto
  captions word-by-word (manual subs have one word = the whole line). One yt-dlp
  extraction (`_caption_tracks`, cached) backs both this and the language list.
- **Caption languages** (`/api/feed/caption-langs/{id}`) — which of English /
  中文 / 日本語 / 한국어 the video genuinely **provides** (uploaded subs or the
  original ASR track — *not* YouTube's auto-translations, which would list all four
  on nearly every video), plus the `native` track code, for the watch page's
  caption-language switcher. **Persisted** in the `caption_langs` table after the
  first extraction: deriving it costs a yt-dlp call the caption menu waits on, and
  a video's languages never change. Stores the derived codes, not the raw track
  info — that blob is ~512KB with ~7h-signed URLs, so it would be both fat and
  stale.
- **AI-translated captions**
  (`/api/feed/captions-translate/{id}?lang=<source>&at=<seconds>&count=<n>`) — a run
  of **whole sentences** around playback position `at`, translated into
  **Traditional Chinese**. Returns `{lang, sentences: [{start, end, text}]}`,
  ready to render as-is.

  **Sentences, not cues** — this is the whole trick. A cue is an arbitrary
  mid-clause fragment, and its split point does *not* survive translation: English
  trails its modifiers where Chinese leads them, so `…create time and space / for
  her own exploration` has to come out as `為她自己的探索/創造時間和空間` — the halves
  swap. Demanding a 1:1 mapping over fragments forces the model to choose between
  natural Chinese and the line count, and it silently merges lines: measured
  30/40, 36/40, 23/28 returned. Feeding it whole sentences (`_to_sentences`)
  removes the conflict — the same models then return 10/10 every time, and the
  Chinese reads properly instead of being chopped mid-clause.

  Requests are position-based so the watch page can translate **as playback
  approaches**, like video buffering: a long video is never translated past where
  it's watched (a 37-min podcast used to mean ~2min of waiting), and a seek
  translates where you *landed* rather than restarting from 0:00. Results merge
  into the sparse per-sentence `caption_translations` map, so they survive a
  restart and a re-watch is free. Grouping also shrinks the job — 158 cues become
  49 sentences.

  The video's **channel and title go in as context** so the model picks
  domain-appropriate terminology instead of guessing from a few stray lines.
  Lines go out numbered and come back numbered — *not* JSON: the model reliably
  drops a quote or comma somewhere in a 40-element array, killing the whole batch,
  whereas a numbered list is addressable per line, so a mangled or skipped line
  falls back to its source text and everything else stays aligned to its timing.
  A batch gets one retry; a batch that fails outright degrades to source text.

  Results merge into `caption_translations` keyed by the **resolved** source
  track, not the requested code, so `""` (native) and `"en"` on an English video
  don't translate — and pay — twice.

  Things that make it fast, in descending order of impact:
  1. Model: `llm_translate_model` is `google/gemini-2.5-flash-lite`. Read while
     the video plays, so it's picked for speed — a 1.6s median against 5.0s for
     deepseek at the same ~$0.0001/batch. (Tagging stays on deepseek, where
     background latency doesn't matter.)
  2. `provider_sort="latency"`, not `"throughput"` — a batch is ~170 output
     tokens, so time-to-first-token dominates and tokens/sec barely matters.
     Over 5 calls, throughput ran a 10.2s median / 20.5s max vs latency's 4.4s /
     9.5s. (OpenRouter's default spread is the biggest source of variance at all:
     5s on Baidu vs **212s** on Ambient.)
  3. `reasoning=False` — a reasoning model otherwise spends 4-6x its output
     budget thinking (2,769 reasoning tokens to produce 480 of translation).
  4. Batches run **concurrently** on their own pool (`_translate_pool`), so a long
     video can't hog `_preview_pool` and starve hover previews.

  Batch size is *not* a latency lever: it's set by provider choice, not payload —
  12 lines measured a 7.3s median against 5.7s for 40.
- **Descriptions** (`/api/feed/description/{id}`) — the watch page's description
  box. Kept out of the DB deliberately: they run a few KB each and only one page
  ever wants one, so a TTL cache is the whole storage story.

The storyboard fetch is a full extraction that already carries the description,
so it stashes it in the description cache on the way past (`_fetch_storyboard`
shares `_extract_info` with `_fetch_description`). Hovering a card is nearly
always how you reach the watch page, so by the time the description is asked for
it's usually warm — ~9ms, instead of another ~1s extraction on a cold open.

> Some videos genuinely have no description (3 of a 50-video sample), and the
> negative cache keeps those from being re-fetched on every open. An empty box is
> real data rather than a failed fetch — worth knowing before you debug one.

## Offline downloads (`routers/downloads.py`)

The Downloads library fetches videos to disk with yt-dlp and serves the file
back via `FileResponse`. The frontend then plays the **local file** in the
preview card (a `<video>` element behind the same player interface) instead of
the YouTube embed — so downloaded videos preview and play fully offline.

---

## Watch history (`routers/history.py`)

One row per video ever played, upserted by the watch page every ten seconds and
once more on the way out. Three things read it: the watch page (resume), every
video card (the red bar drawn before you hover), and the History page.

The `watch=` filter on `/api/tags/feed` and `/api/channels/{id}/videos` reads
the same table: `unwatched`
is the absence of a row, `in_progress` a row, `watched` a row with the flag. It's
applied **before ranking and paging**, so `total` and the offsets stay honest —
filtering a page client-side would leave the count promising videos it then drops.

**Watched** is decided in one place, server-side, so nothing downstream has to
re-derive it: at 90% of the duration — past that it's credits and end cards — or
within the last minute, which covers long videos where 90% still leaves a
quarter of an hour. It's **sticky**: reaching the end once is enough, so a
rewatch that stops halfway doesn't mark the video unfinished again.

`watched` is the record that you finished it once; `position_seconds` is where
you are *now*. They diverge during a rewatch, and everything that shows progress
follows the position — so a rewatch resumes, and its card bar tracks the rewatch
rather than staying pinned full from the first time round.

Two guards keep the data honest:

- Nothing is recorded below `MIN_POSITION_SECONDS` (5s), so a misclick or a card
  you bounced off never lands in history.
- A progress ping that carries no title doesn't overwrite the metadata snapshot.
  The watch page can report a position before its metadata resolves, and without
  this that ping would blank a row that already had one.

---

## Bookmarks (`routers/bookmarks.py`)

Moments in a video, marked with `b` while it plays. Server-side for the same
reason as history: the mark is about the video, not the browser that made it.

Deliberately thinner than history — add, list, delete, no upsert. Two decisions
carry all of it:

- **Many rows per video**, ordered by position. A bookmark is an event, not a
  state, and keeping several is the whole point.
- **One untyped `video_id`.** The watch page plays a YouTube video, a downloaded
  copy of one, or a file from a local folder; the first two share the YouTube id
  and the third uses the `local_videos` hash. All three are opaque strings here,
  so one table covers every source with no per-source column and no join that
  differs by source.

"Press `b` again at the same spot to remove it" is the **client's** rule (±2s),
not this router's: the page already holds the list, so it can answer instantly
instead of asking — and it's the only way to remove one, since the marks live on
the progress bar rather than in a list with delete buttons. Delete is `/api/bookmarks/id/{n}` — the `/id/` segment keeps
it from reading as the video id that the GET takes in the same slot.

The A–B repeat loop has nothing here. It's about this sitting rather than the
video, so it lives in frontend state and dies with the overlay.

---

## Imported videos (`routers/imported.py`)

The feed only ever shows videos from channels you're subscribed to, so a link
someone sends you has nowhere to live. `POST /api/imported` takes the pasted
text verbatim, pulls every video id out of it (watch / `youtu.be` / shorts /
live / embed URLs, or a bare 11-char id), and fetches each one's metadata with
yt-dlp on a small bounded pool.

Partial success is the normal case — one dead link among five — so nothing here
raises: every input lands in exactly one of `added` / `skipped` (already
imported) / `failed`, and the UI reports the tally and keeps the failures in
the box for a retry. Duplicates inside one paste collapse to the first.

`is_short` isn't something yt-dlp reports, so it's inferred the way the format
is defined: portrait and at most 180s.

---

## Local folders (`routers/local.py`)

Not everything worth watching came from YouTube. Point `POST /api/local/folders`
at a directory on the machine running the backend and its videos become a feed:
the files are listed, served with range support (so seeking and the scrub
preview work), given a poster frame, and remembered where you stopped.

Each folder stays its own page. Folders are added and removed whole, and merging
two unrelated directories into one list would throw away the only grouping the
user gave us.

**Nothing here writes to the user's directory.** Files are read, probed and
served; removing a folder deletes our rows and the thumbnails we generated,
never the videos.

**Scanning is split in two, because reading a file is expensive.** The walk is
stat-only and returns immediately; durations come from `ffprobe`, which has to
read the file — on a cloud-synced drive (Google Drive, iCloud) that streams the
whole thing down. Measuring 32 such files took **three minutes** in testing, so
a listing never waits on it: new files land with `probed = false`, a background
pass measures them a few at a time and commits each batch, and the response
carries `scanning: true` so the page can poll and fill durations in as they
arrive. `_start_probe` registers the folder **synchronously** — a flag set inside
the task would leave the very response that scheduled the pass reporting
`scanning: false`, and the UI would never poll.

`probed` is its own column rather than `duration_seconds == 0`: probing can
legitimately come back with nothing (an unreadable file), and retrying that on
every page view would re-stream it forever.

Poster frames are extracted by `ffmpeg` on first request and cached under
`data/local_thumbs/`, a tenth of the way in so they aren't a black fade-in.
A file whose size or mtime changed is re-probed and its thumbnail dropped —
both describe a file that no longer exists.

Resume lives here (`position_seconds`, `watched`) rather than in `watch_history`:
that table is keyed by `youtube_id` and its page renders YouTube cards, and a
file on disk is neither.

---

## LLM client (`llm.py`)

A thin wrapper over OpenRouter's chat-completions API, shared by every AI
feature (channel tagging, video topics, caption translation). Model, key and
base URL come from `settings`; `llm_tagging_model` and `llm_translate_model`
are separate knobs so translation can diverge from tagging.

Three behaviours here are not obvious and were each paid for in debugging:

- **`chat_json` repairs trailing commas.** Models emit `[... ,]` often enough to
  matter, and strict `json.loads` rejects it — one stray comma used to kill a
  whole 40-line batch. The repair only runs *after* a strict parse fails, so it
  can't corrupt an otherwise-valid reply. If you need stricter output than this
  can rescue, prefer a numbered-line format over JSON (see caption translation).

- **`reasoning=False` skips chain-of-thought.** Worth setting for mechanical work
  (translation, extraction). Reasoning models otherwise spend 4-6x their output
  budget thinking first — measured **2,769 reasoning tokens to produce 480
  tokens** of translation — which is both the dominant cost and the dominant
  latency. Whether it fires is provider-dependent, so leaving it on also makes
  timings unpredictable.

- **`provider_sort` pins one provider.** OpenRouter's default spread across
  providers is the single biggest source of latency variance: the *same* 40-line
  request measured **5s on Baidu and 212s on Ambient**. Prefer `"latency"` over
  `"throughput"` for short bursts like a caption batch (~170 output tokens), where
  time-to-first-token dominates: over 5 calls, throughput ran a 10.2s median /
  20.5s max while latency held 4.4s / 9.5s. Which provider each lands on drifts
  day to day.

Callers that skip these get correct-but-slow-and-erratic behaviour, which is
easy to misread as a model or network problem.

---

## Channel tagging (`routers/tags.py`, `llm.py`)

Channels are tagged by an **LLM**, not keyword rules. Tags drive the sidebar
filters and the per-channel label editor.

- **Seed taxonomy** (`SEED_TAXONOMY`) — 9 fixed groups (Language, Entertainment,
  Music, Gaming, Sports, Lifestyle, Tech, Knowledge, Society), each with broad
  **main** labels (auto-applied) and specific **sub** labels (offered as
  suggestions). Groups are the sidebar's navigation frame; empty ones are hidden
  per user, so the same universal taxonomy shows a different slice for everyone.
- **Labeling** (`llm_label_channel`) — the model gets the channel's name,
  description, and YouTube topic hints (`channels.topics`, fetched during resync)
  and returns `{main, suggested}`. Only seed main/language labels can be
  *applied*; anything else it returns — a misplaced label, or a new sub it
  invents when a topic isn't covered — is demoted to a **suggestion**. It never
  invents new main labels or groups. Language falls back to the deterministic
  video-title script detector when the model omits one.
- **Caching** — each verdict is stored on `channels.llm_labels` so suggestions
  and re-runs don't re-hit the API. `POST /api/tags/auto-assign` re-tags every
  channel and runs in a **background thread** (one API call per channel takes
  minutes); poll `/api/tags/auto-assign/status`. Resync tags only newly-added
  channels, inline.
- **Editing** — `POST/DELETE /api/tags/{channel_id}/tag/{tag}` apply/remove a
  label on one channel. Accepting a suggestion stores it as **manual**
  (`auto_assigned=0`) so re-tagging never clobbers it. Removing an auto label
  writes a **rejection** (`channel_tag_rejections`) so re-tagging doesn't
  resurrect it, and demotes it back to a suggestion. Machine does the bulk; the
  user makes the per-channel calls only they can judge.

> Why LLM over keywords: keyword matching couldn't tell "a channel *about* X"
> from one that merely *mentions* X — a bio "I used to work at Intel" read as
> tech; descriptions that enumerate topics matched everything — and it leaned on
> per-channel name hardcodes that rotted silently.

Uses OpenRouter (`llm.py`, model `settings.llm_tagging_model`). If
`OPENROUTER_API_KEY` is unset the call degrades to language-only, so tagging
never hard-fails.

---

## Video topics (`video_labels.py`, `routers/channels.py`)

Separate from the channel tags above: each **video** is labeled by topic from
its title, with a **vocabulary tailored per channel** (not the shared taxonomy).
A sports channel gets `baseball` / `MLB` / `football` / `FIFA世界盃`; a travel
vlog gets `travel` / `紐西蘭`. These are the **TOPICS** chips the sidebar shows
in place of the global taxonomy while you're on a channel page; clicking one
filters that channel's videos.

- **Build** (`build_channel_vocab`) — labels the whole channel and derives the
  vocabulary (labels landing on ≥2 videos). Two passes for recall: an
  open-ended pass discovers labels, then a **constrained** pass re-labels only
  the videos that came back empty against the now-known vocab (the model just
  matches a list, which the free model does far more reliably than inventing).
  The model also gets the **channel name + taxonomy themes** as grounding, and a
  **denylist** strips language / whole-channel words (`chinese`, `vlog`,
  `entertainment`) it tends to echo back. Runs in a background thread, 8 batches
  at a time, with progress; poll `.../labels/status`.
- **Full per-video labels** — each video stores *all* its labels (not just the
  vocab ones), so a specific one-off like `紐西蘭` survives on the video (and its
  watch page) even though it's too rare to be a channel-wide chip.
- **Chips** are tallied from the videos actually in view, scoped to the current
  **window + videos/shorts mode**, so a chip's count equals what filtering by it
  shows. Adaptive declutter: single-video topics are dropped only once ≥30
  topics have 2+ videos in view (big channels stay tidy, sparse ones keep
  everything). `?label=` filters server-side, before pagination.
- **Versioning** — `LABEL_VERSION` stamps each build; bump it and every channel
  re-labels itself on its next visit. A stale channel reads as unbuilt, so the
  channel page rebuilds it automatically.
- **New uploads** — `assign_labels` labels videos added after the build, lazily,
  as the channel page renders them.
- **Up to `MAX_LABELS` (6) per video, capped LAST.** Six is the shape these
  titles actually have — game + esports + league + both teams + a player. The
  cap is applied *after* non-vocab labels are dropped, so a 5th label that is a
  real chip can't lose its place to a 3rd that gets discarded a step later.
  Filtering is a server-side query on `title_labels`, so a truncated label
  doesn't just shorten a chip row — it removes the video from that chip's
  results.

**The channel's own subject is not a topic.** An LoL channel labeling every
video `League of Legends` produces a chip that returns the whole channel and
spends one of six label slots saying what you already knew. Each channel carries
a `label_stop_words` list, decided BEFORE labeling and fed to the model as
"never output these", then enforced deterministically (asking nicely is not a
filter). It's seeded from two stable sources: the channel's own taxonomy tags,
and **one cheap call per build** — name, themes and 40 sample titles in, "what
would be true of every video here?" out. That call answered `League of Legends`,
`海賊王`, `art`+`drawing`, `real-estate` on the four channels it was tried on.

An earlier version *measured* coverage instead and dropped labels found on ≥75%
of videos. It doesn't work: the labeler's recall wobbles, so the same universal
label measured **81% on one build and 67% on the next** over the same 1049
videos. Deriving beats measuring when the thing you'd measure is the noise.

**Verbatim backstop.** After the model answers, any vocabulary term written
literally in the title is added to that video's labels. `DK vs G2 …` and
`2026 LCK常規賽` carry the answer in the text, and the model's recall is the
weak link — the identical batch at `temperature=0` returned the teams 5/5, 5/5,
then 1/5. Matching costs no tokens and never varies. ASCII terms need word
boundaries (`AL` must not fire inside `GAL`); CJK matches as a substring. It took
"both teams labeled" on `A vs B` titles from patchy to **94% (751/796)**.

**Labels match space- and punctuation-insensitively** (`_key`), so
`League of Legends` / `leagueoflegends` are one label rather than two chips.

**A failed batch is not an answer.** `_label_batch` degrades to `{}` on any
failure (dead key, rate limit, JSON truncated by `max_tokens`), and a video
missing from the reply is indistinguishable from one the model deliberately gave
no labels. So `assign_labels` persists **only** the videos the batch answered
for: anything else stays `NULL` and is retried on the next render. Writing `[]`
there made a transient failure permanent — `[]` is never re-labeled, only `NULL`
is — and quietly stranded whole pages of videos with no topics.

**`reasoning=False` is load-bearing here**, not a tuning knob. Matching 50 titles
against a fixed list is mechanical, and with reasoning on the model spent its
whole budget thinking and returned empty content (`finish_reason=length`) — most
batches failed, which stranded videos with no labels and left the channel page
saying "finding topics" for minutes. With it off: 50/50 titles answered in 19.6s
on 1,047 completion tokens, against 8,192 burned for nothing.

Same OpenRouter client/model as tagging; unset key ⇒ no topics, never a crash.
Note that a 200 from OpenRouter doesn't guarantee a completion: `llm.chat`
raises `LLMError` on null content (model emitted only reasoning tokens, or was
cut off) rather than returning `None` for a caller to trip over.

---

## Data model (`models.py`)

| Table | Purpose |
|---|---|
| `channels` | subscribed channels (id, title, `last_video_fetched`, `topics`, `llm_labels`, `video_label_vocab` + `video_label_version`, `label_stop_words`) |
| `videos` | scraped videos (stats, `published_at`, `is_short`, `title_labels`, `last_updated`) |
| `channel_tags` | channel↔tag assignments (`auto_assigned`: 1 = LLM, 0 = manual) |
| `channel_tag_rejections` | auto tags the user removed, so re-tagging won't re-add them |
| `watch_later` | saved-for-later videos (server-side, syncs across devices) |
| `playlists` / `playlist_items` | user playlists |
| `downloads` | videos downloaded to disk for offline viewing |
| `hidden_channels` | channels hidden from the home feed (excluded in the feed query) |
| `imported_videos` | one-off videos added by URL, from channels you don't follow |
| `watch_history` | how far you got in each video, and whether you finished it |
| `bookmarks` | moments marked with `b` while watching — many rows per video, one untyped `video_id` covering YouTube ids and local ones alike |
| `local_folders` | directories browsed as feeds (absolute path + display name) |
| `local_videos` | one video file inside a local folder — cached duration/size/mtime, its own resume position |
| `caption_translations` | AI caption translations, keyed by (video, source lang, target lang) — the one cache worth persisting, since rebuilding costs tokens and minutes |

`watch_later`, `playlist_items`, `downloads`, `imported_videos` and
`watch_history` each store a
**metadata snapshot** of the video so a card still renders even after the video
ages out of the feed window. `imported_videos` is deliberately NOT `videos`:
every feed query joins `videos` to the SUBSCRIBED channel set, and an imported
video's channel has no `channels` row, so a row there would be invisible anyway
while polluting the scan and ranking paths. Schema is created by `Base.metadata.create_all`; new columns
are added by the tiny additive-migration list in `database.py`.

---

## Config (`config/`)

- **`subscriptions.yaml`** — the channels to follow (imported via the OAuth flow
  in `auth_google.py`, or edited by hand). `POST /api/subscriptions/resync`
  reconciles this against your live YouTube subscriptions: it **fully deletes**
  channels you've unsubscribed from (their videos, tags, hidden/category entries,
  and search docs) and adds any new ones. Your saved data — downloads,
  watch-later, playlists — is snapshot-keyed by video id and left untouched.
  Preview first with `?dry_run=true`; an empty subscription response aborts the
  prune rather than wiping the DB.
- **`categories.yaml`** — legacy keyword rules that sort each channel into **one**
  feed category (`categorizer.py`). Superseded by the LLM tag system for the
  sidebar; still read by the resync prune when cleaning up removed channels.
- **`youtube_oauth_token.json`** — the Data API token refreshed by the in-app
  "Re-authenticate" link. Stats fall back to yt-dlp if it's missing/expired, so
  OAuth is **optional**.
- **`.env`** (in `backend/`, gitignored) — secrets. `OPENROUTER_API_KEY` powers
  LLM channel tagging; without it, tagging degrades to language-only. See
  "Channel tagging". The tag taxonomy itself lives in code (`SEED_TAXONOMY`), not
  a config file.

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

- **Caption translation gets its OWN pool** (`_translate_pool`, 6 workers), not
  `_preview_pool`. A long video is dozens of LLM batches, each occupying a worker
  for seconds, so sharing would let one translation hog every worker and stall
  hover previews and storyboards. The worker count doubles as the per-request
  concurrency limit: batches run in parallel (wall time is the slowest batch, not
  the sum) but queue rather than hitting the API all at once. A per-video
  `asyncio.Lock` serialises the read-modify-write of the stored sentence map, so
  two overlapping block requests can't clobber each other's merge.

---

## Key endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/feed` | ranked feed grouped by category (query: window, sort, tags…) |
| GET | `/api/feed/storyboard/{id}` | hover-scrubbing storyboard frames |
| GET | `/api/feed/captions/{id}` | timed caption cues with per-word segments (query: `lang`; rendered by the frontend) |
| GET | `/api/feed/caption-langs/{id}` | caption languages the video offers (English/中文/日本語/한국어) |
| GET | `/api/feed/captions-translate/{id}` | AI-translate captions to Traditional Chinese — returns whole sentences around a play position (query: `lang` = source track, `at` = seconds, `count` = sentences) |
| GET | `/api/feed/video/{id}` | one video's metadata + `title_labels` (for the in-app watch page / deep links); falls back to the `imported_videos` snapshot |
| GET | `/api/feed/description/{id}` | one video's description, fetched on demand (never stored) |
| GET | `/api/channels/{id}/videos` | a channel's ranked videos + topic chips (`?label=` filters by topic) |
| POST | `/api/channels/{id}/labels/build` | build this channel's video-topic vocabulary (background; `?force=1` rebuilds) |
| GET | `/api/channels/{id}/labels/status` | `{building, built, progress}` for the topic build |
| POST | `/api/channels/{id}/labels/assign` | label the given (rendered) videos against the vocab |
| GET | `/api/search?q=` | typo-tolerant search (channels + videos) |
| GET | `/api/tags` | tags in use with per-tag counts (`?include_empty=1` = full taxonomy, for the picker) |
| POST | `/api/tags/auto-assign` | background LLM re-tag of every channel; poll `/api/tags/auto-assign/status` |
| POST/DELETE | `/api/tags/{channel_id}/tag/{tag}` | apply / remove one label on a channel (accept a suggestion / reject an auto tag) |
| GET/POST | `/api/watch-later`, `/api/playlists`, `/api/downloads` | resource CRUD |
| GET/POST/DELETE | `/api/imported` | imported videos: list / import a paste of links / remove one |
| GET/POST/DELETE | `/api/history` | watch history: list / report a position / forget one. `GET /api/history/{id}` is the resume lookup |
| GET/POST/DELETE | `/api/hidden-channels` | list / hide / un-hide channels from home |
| GET/POST | `/api/bookmarks` | `GET /api/bookmarks/{video_id}` = one video's marked moments, in playback order; POST adds one. `DELETE /api/bookmarks/id/{n}` removes one |
| GET/POST | `/api/local/folders` | list local folders / add one by path (scans it) |
| GET | `/api/local/folders/{id}/videos` | that folder's videos (`?rescan=false` = cached listing, used by the scanning poll) |
| DELETE | `/api/local/folders/{id}` | forget a folder — our rows and thumbnails only, never the files |
| GET | `/api/local/videos/{id}/file` \| `/thumb` | the file itself (range requests) / its poster frame |
| POST/DELETE | `/api/local/videos/{id}/progress` | record / clear where playback got to |
| POST | `/api/subscriptions/resync` | sync DB to live YouTube subs — prune unsubscribed, add new (`?dry_run=true` to preview). Also runs daily on its own |
| POST | `/api/channels/{id}/backfill` | fetch older videos for a channel via the Data API uploads pager (`?years=N`, `<=0` = all) |
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
