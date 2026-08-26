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
| YouTube scraping | **yt-dlp** (flat mode for listings, full extract for storyboards/captions, `getcomments` for comments) |
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

  cron_update.py   run_update(): the actual channel-scan job (Phases 1–5)
  app_settings.py  preferences (DB-backed; per-user or per-deployment by scope)
  archive.py       deep per-channel history, under a daily quota budget
  channel_lookup.py  a pasted link/@handle/id → a channel (see "Adding a channel by hand")
  quota.py         Data API units spent per quota-day (midnight US/Pacific)
  fetcher.py       yt-dlp wrappers (channel listings, video details)
  youtube_api.py   YouTube Data API v3 batch stats (+ token handling)
  ranking.py       score = views / hours-since-published; age-range resolving
  categorizer.py   legacy keyword → feed-category rules (config/categories.yaml)
  llm.py           OpenRouter chat client, shared by AI features
  video_labels.py  LLM per-video topic labeling (see "Video topics")
  search_index.py  Meilisearch push + query (best-effort)
  auth_google.py   Google sign-in: the OAuth flow, /auth/me, /auth/logout
  auth.py          reading the caller back: session cookie or extension API key
    routers/people.py  the household: adding people, and the links that let them in
  users.py         accounts: seeding, the channel backfill, adoption (see "Accounts")

  routers/         one file per resource, all mounted under /api
    feed.py        the main feed, storyboards, captions + AI translation, comments
    channels.py    channel pages + video-topic chips/filtering (see "Video topics")
    search.py      proxies to search_index
    tags.py        LLM channel tagging + taxonomy, tag editor (see "Channel tagging")
    history.py     watch positions — resume, the card's progress bar, History
    imported.py    videos added by pasting a YouTube link (metadata via yt-dlp)
    local.py       local folders: scan a directory, serve its files, remember positions
    settings.py    app settings, served with the spec the UI renders from
    ask.py         questions about a video, answered from its transcript (streamed)
    summaries.py   the same answer, written in the background from a card
    notifications.py  the bell: what finished while you were on another page
    watch_later.py / playlists.py / downloads.py / subscriptions.py

config/            categories.yaml, subscriptions.yaml, oauth token
.env               secrets + deployment wiring (OPENROUTER_API_KEY); gitignored
                   — user-facing preferences live in app_settings.py instead
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

### A time window is a pair of ticks on a ladder

Requests carry `age`, a publish-age range in days: `age=0-3` is "the last three
days", `age=3-14` is "published 3 to 14 days ago". Both edges must land on the
ladder of boundaries in `TICK_DAYS`:

```
days:    0     1     3     7    14    30    90   180   365    ∞
label:  now   1d    3d    1w    2w    1m    3m    6m    1y   all
```

`resolve_range()` turns the request into the `(newer, older)` offsets from now
that `filter_by_range()` compares against. Off-ladder days snap to the nearest
tick (a dead tie goes to the tighter window), a reversed pair is read in the
order it meant, and a zero-width range is a 422 rather than a silently empty
feed.

**The older edge can be unbounded.** `age=0-all` is everything held, `age=30-all`
is everything older than a month — which is how a channel's deep archive is
reachable at all, since the finite ladder stops at a year. It resolves to an
older offset of `None`, and a query with `None` there omits its lower bound
rather than inventing a floor (`range_cutoffs()` returns the pair a `WHERE`
wants). Only the older edge may be unbounded; `all-30` is a 422. The token
spells itself rather than standing in for a big number, because a sentinel that
looks like a day count reads as data everywhere it travels — and it means
`nearestTick` can never land on it, so `age=0-99999` still means "the past
year".

The preset row this replaced could only reach ranges anchored at 0 or exactly
one notch wide: 15 of the 36 pairs the ladder allows. A window like `3-14` —
starting away from now *and* several buckets wide — had no spelling at all.
Naming both edges is what the UI's two-handled slider needed, and it makes the
old narrow/wide mode flag redundant: "wide" is just a range whose newer edge
sits at 0. A request that names no `age` gets `DEFAULT_AGE` ("0-3").

**A window is fetched, not trimmed to.** Both feed and channel queries put the
range in the SQL `WHERE` and cap at `WINDOW_FETCH_CAP` (10,000) purely as a
safety net. The channel page used to take the newest 2,000 rows and filter
afterwards, which meant that on a channel posting faster than that the older
half of the ladder could never match anything — the rows were in the table, the
query just never saw them. The cap that remains says so in the log when it bites,
because a silently short list reads as "nothing there".

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
   to collect video IDs and upsert rows (fast, no JS challenges). This costs no
   API quota and runs for every channel every pass, which is why no channel is
   ever left with nothing however the archive fill below is ordered.
2. **New-video stats** — batch-fetch real view/like counts for newly-seen
   videos via the YouTube Data API (yt-dlp fallback if the token is dead).
3. **Stale-video refresh** — re-fetch stats for recent videos on an age-based
   schedule (newer videos refresh more often).
4. **Archive fill** — deep per-channel history, under a quota budget. Off unless
   `ARCHIVE_FILL_ENABLED` (see below).
5. **Reindex** — push updated titles/stats into Meilisearch.

Phases 2–4 all spend Data API quota and all record it in the persisted ledger.
A `quotaExceeded` refusal stops the rest of the run rather than being retried.

yt-dlp is configured to **fail fast** (`fetcher.py`: `socket_timeout` 10,
`retries` 1) — its default ~10× retries over 130+ channels used to exhaust the
process's sockets.

The scanner only ever walks channels **already in the DB** — it never re-reads
your YouTube subscription list. That's a separate, much slower loop:

### The daily subscription resync

`_resync_loop()` runs `POST /api/subscriptions/resync`'s logic **once a day per
person** (`RESYNC_INTERVAL_SECONDS`), so subscribes and unsubscribes land on
their own. It's daily rather than per-scan because it costs an OAuth round-trip
and its prune is destructive — the last holder unsubscribing takes the channel's
videos with it.

One list per person means one clock per person: `_due_users()` reads every
`User.last_resync_at` and reconciles whoever is overdue. A resync only ever sees
what **that** person holds, so it can't reach another account's channels.

Four things make it safe to run unattended:

- **The clock is `User.last_resync_at`**, stamped by a successful resync — not a
  sleep timer. A sleep timer would either re-run the prune minutes after every
  restart, or push the next resync a full day out on a machine that reboots
  daily. (It was `subscriptions.yaml`'s mtime, back when one file could stand for
  one person's list.)
- **It never raises.** A dead token or an API hiccup logs and backs off
  (`RESYNC_RETRY_SECONDS`, default 1h) instead of killing the task; if there's
  no OAuth token at all it skips without even calling YouTube.
- **It holds the scan guard** (`_refreshing`) for the whole reconcile, so a
  scheduler tick can't start a scan halfway through the prune — and it won't
  start while a scan is already running.
- **It dry-runs first and refuses a big prune.** More than `RESYNC_MAX_PRUNE`
  (default 5) channels going at once is likelier a truncated response from
  YouTube than a real unsubscribe spree, and each one can take a year of videos
  with it. It aborts loudly and leaves the call to the manual endpoint.
- **Unfollowing is not deleting.** The membership always goes; the channel and
  its videos only follow it when nobody else here holds them
  (`users.orphaned_channel_ids`).

What it deliberately does **not** touch: `last_video_fetched`, `llm_labels`,
`video_label_vocab`, or the tags of channels you're still subscribed to.
`import_subscriptions` updates existing rows field-by-field rather than
replacing them, so the daily run never re-triggers a channel's 1-year backfill
and never re-spends LLM tokens — only genuinely new channels get scanned from
scratch and auto-tagged.

The endpoint remains for forcing one by hand, and `?dry_run=true` still previews.

### Adding a channel by hand (`channel_lookup.py`, `routers/channels.py`)

A subscription is one way for a channel to reach the `channels` table, not the
only one. `POST /api/channels/add` takes whatever you had — a channel URL of any
vintage, an `@handle`, or the bare id — and writes the same row a subscription
import would have. From there it's an ordinary channel: the scan picks it up
(`run_update` reads the table, not `subscriptions.yaml`), it's auto-tagged, it
ranks in the feed, and the archive fill will eventually walk its back catalogue.

**`Channel.source` is the whole reason this is more than one INSERT.** Resync
deletes every channel that isn't in your live subscription list, and a
hand-added one never will be — so it's marked `"manual"` and the prune skips it
(`_prune_channels`' caller). Subscribing to it on YouTube later flips it back to
`"subscription"`, because then the live list really does own it.

Resolving is two-tier, cheapest first:

- **The Data API** answers an id or an `@handle` for one quota unit and brings
  `topicDetails` with it, which is what the auto-tagger reads.
- **yt-dlp** answers anything, including the legacy `/c/` and `/user/` vanity
  URLs the API has no field for, and needs no credentials — so it's also the
  fallback for an expired token or a spent allowance.

`GET /api/channels/lookup?q=` runs the same resolver and writes nothing: it's
what the add dialog and the you-don't-hold-this-channel page show you *before*
offering to add anything.

**The first scan is a background task, and must stay one.** `scan_channel_videos`
calls yt-dlp straight from async code, so for the twenty-odd seconds it runs the
event loop stops dead. Awaited inside the request handler, that freeze lands
between the response being built and its being written — the browser sits on a
request the server has already finished. So the endpoint returns as soon as the
row exists, with `scanning: true`; the channel page polls the same flag on
`GET /channels/{id}/videos` and fills itself in. Stats, the search index, the
Shorts flag and the LLM tagging all ride along behind the scan.

`DELETE /api/channels/{id}` removes a hand-added channel and its videos (reusing
`_prune_channels`, so your downloads, playlists and Watch Later survive). It
refuses a subscribed channel on purpose: deleting one would last exactly until
the next resync put it back. Unsubscribe on YouTube, then resync.

### The archive fill (`archive.py`) — deep history, on a budget

The flat scan is **count-bounded** (newest ~50/tab), which for a firehose channel
is a few days. Depth comes from paging the channel's uploads playlist through the
Data API instead, which is quota-priced — so unlike everything else in the scan,
it has to be budgeted rather than simply run.

**Measured cost:** 1 unit lists 50 videos, 1 unit stats 50, so **~40 units and
~12s per 1,000 videos**, plus ~0.4 MB of SQLite. Against a 10,000/day allowance,
a whole library of ~194,000 videos is ~7,000 units — affordable, but spread over
days rather than taken in one bite.

Four things make that work:

- **A cursor per channel** (`channels.archive_cursor`). A `nextPageToken` is a
  self-contained cursor: stored, it resumes the walk in a different process days
  later with identical results. Without it, deepening a channel that already
  holds 8,000 videos would mean re-walking 160 pages of known IDs every time.
- **A daily budget** (`quota.archive_budget()`). At most 25% of the day's units,
  and never into the reserve the stale-refresh needs. The sweep stops when it's
  gone and resumes after the midnight-Pacific reset.
- **Ascending remaining.** Channels owing the least go first — shortest-job-first.
  It can't finish the sweep sooner, but on this library it turns "8 of 133
  channels complete after day one" into "120 of 133". A channel never walked
  sorts ahead of one already in progress, so a new subscription doesn't queue
  behind a three-day firehose.
- **The budget is counted in pages, not in what the meter reports.** One page is
  exactly one unit, so the two agree — but a stopping condition that is a
  measurement can be argued out of stopping by a bad measurement, and "walks
  YouTube forever" is not a failure worth leaving open.

**It is off by default**, and the switch is **Settings → Library**, not an env
var. Turning it on commits the quota and the disk for every channel's back
catalogue, so it should be a decision rather than a side effect of a deploy —
but turning it *off* has to take effect immediately, and "edit .env, restart
uvicorn" is the wrong shape for a kill switch on an unattended job that spends a
metered resource. The runner re-reads the setting **between channels**, so a
sweep already in flight stops rather than finishing its budget.
(`ARCHIVE_FILL_ENABLED` in `.env` survives only as the *bootstrap* default: it
seeds the first read and is ignored once the setting has been stored.)
What is *not* gated: the
per-channel `POST /api/channels/{id}/archive`, which is a thing you asked for by
name while looking at the channel; and the lifetime-count lookup that gives the
UI its denominator (~1 unit per 50 channels, charged to the day but not to the
archive's share, so opening a channel page can't eat the fetching budget).

**Two ceilings, both real.** The uploads playlist stops at 20,000 items whatever
the channel's true `videoCount` says (`ARCHIVE_CEILING`) — a 40,097-video channel
can only ever give up half of itself, so progress is shown against what's
*reachable* and the shortfall is stated rather than left as a bar that never
fills. And Shorts labelling is a fixed ~4s yt-dlp call against the `/shorts` tab,
so it runs **once, when a channel's walk finishes** — never per page. A channel
mid-fill has its newest Shorts labelled and its older ones provisionally filed as
long-form until the walk completes.

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

### Comments (`/api/feed/comments/{id}`)

**The Data API cannot serve these.** `commentThreads.list` costs a single quota
unit and would be the obvious choice, but it requires the `youtube.force-ssl`
scope and the app's token is `youtube.readonly` — asking for it returns 403
`ACCESS_TOKEN_SCOPE_INSUFFICIENT`. Opening that path means widening `SCOPES` in
`auth_google.py` and re-consenting the Google flow.

So comments come from yt-dlp's `getcomments`, which walks the same innertube
pages the YouTube watch page walks: **no key, no token, and nothing charged
against the quota ledger** — the same footing as descriptions and captions.

What it costs instead is time, and the shape of the feature follows from where
that time goes:

| walk | what it brings back | measured |
| --- | --- | --- |
| `?sort=top` | 40 top-level comments | ~2.2s |
| `?sort=top&replies=1` | the same 40, plus up to 10 replies each | ~14.5s |

Replies are several times the wait because YouTube hands them over **one thread
at a time** — a request per thread, not per comment. That's why it's two walks:
the watch page shows the comments as soon as the first lands and folds the
replies in when the second does, so nobody waits on the slow one to read the
fast one (see `Comments.tsx`). Both are still gated on opening the panel —
there's no hover prefetch and no remembered open state. Three workers on
`_comment_pool` bound how hard this can page from one address, which is what
earns a bot check.

`_thread_comments` nests the flat list yt-dlp returns, and corrects two of its
field names on the way out:

- **`comment_count` is not the video's comment count.** After a successful walk
  yt-dlp overwrites it with the number extracted — our own cap. The payload
  calls it `fetched`, and sets `capped` so the panel can say "40+" rather than
  letting a truncated list read as a quiet comment section.
- **A disabled section is distinguishable from an empty one**, but only by a
  `None`: `CommentsDisabled` yields `comments: None, comment_count: None`, where
  a video nobody has commented on yields `[]` and `0`. That's the `disabled`
  flag, and it's why the panel can say "comments are turned off" honestly.

`is_favorited` — yt-dlp's name for the *creator's* heart, which reads like
something the viewer did — goes out as `hearted`.

**Replies chain.** A reply's `parent` can be another reply, not just the thread
root, and four levels deep is ordinary — so `_thread_comments` nests by parent
id generally rather than assuming two levels. That's also why the per-thread
reply cap is 10 rather than 3: the cap is a whole conversation's budget, and one
long argument would otherwise consume it and cut every other reply in the
thread. The frontend draws that tree as a tree (see `Comments.tsx`), which is
what YouTube itself does — each level a step further in, with a rule down the
left saying what answers what.

## Offline downloads (`routers/downloads.py`)

The Downloads library fetches videos to disk with yt-dlp and serves the file
back via `FileResponse`. The frontend then plays the **local file** in the
preview card (a `<video>` element behind the same player interface) instead of
the YouTube embed — so downloaded videos preview and play fully offline.

---

## Watch history (`routers/history.py`)

One row per video ever played, upserted every ten seconds by whatever is playing
it — the app's watch page, or the extension on youtube.com — and once more on the
way out. Three things read it: the watch page (resume), every video card (the red
bar drawn before you hover), and the History page.

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

### Reporting with nothing but an id

`POST /api/history/by-id/{id}` takes a play head and a duration and works the
rest out. It's what the extension posts while you watch on youtube.com, so that
watching there and watching here write the same history — one row per video,
latest position wins, `watched` still sticky. Resuming in one place therefore
follows the other.

The caller is on YouTube's page rather than in the app: it has a `<video>`
element and an id. Rather than have it scrape a title and channel out of markup
that changes, the metadata is resolved here by `feed.get_video` — the same
lookup `POST /api/watch-later/by-id/{id}` uses, and for the same reason. (There
is a second reason here: YouTube's watch page exposes no dependable channel id to
a content script at all. See `extension/README.md`.)

The lookup runs **only while the row still has no title**. This endpoint fires
every ten seconds for as long as a video plays, and the answer can't change —
resolving each time would put a YouTube fetch on a path that repeats forever. The
5-second floor is checked first, so a misclick or an ad costs nothing either.

The player's duration wins over the resolved one when both exist: the player is
watching the actual video, and `is_watched` turns on that number.

This endpoint — and only this one — is gated on the `youtube_history_sync`
setting. The extension reads the same flag and stops sampling when it's off, so
the check here is the backstop for the up-to-a-minute window where the
extension's copy is stale. It's checked **before** the metadata lookup, or
turning the feature off would still cost a YouTube fetch. Reporting from the
app's own watch page (`POST /api/history`) is untouched by it: the switch is
about the extension, and a shared gate would turn off more than was asked.

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

## Ask (`routers/ask.py`)

A conversation about a video, answered from **its own transcript** — the same
cues the caption and translation features already parse, handed to the model with
their timestamps still attached. That last part is what makes the feature work at
all: it is why an answer can cite `[14:32]`, and why it can say "that isn't in
this video" instead of answering about the subject in general.

Four decisions carry it:

- **The whole transcript goes in the prompt.** An hour of speech is ~12k tokens,
  which the flash-tier models this app already pays for take without complaint,
  and a model that has seen the whole video beats any chunking scheme at the one
  thing that matters here — knowing what was *not* said. Retrieval is the fallback
  for the rare three-hour video, not the design.
- **When it doesn't fit, the window follows the play head.** Same call the
  translation endpoint makes: on a video long enough to overflow the budget, the
  question is nearly always about where you are. `transcript_window` grows
  outward from the sentence being played, alternating forward and back, and
  reports the span it actually read so the panel can say so rather than quietly
  answering short. The budget is in **characters**, not tokens — the tokenizer
  differs per model, and a character count is one the code can check.
- **Length is the question's to set, and the prompt says so at length.** The
  first version said "be brief" full stop, and a request to summarise a
  36-minute tier list came back as four sentences: three of the thirteen models
  named, the rest silently dropped. The transcript was not the limit — all
  thirteen were in it, some seventeen times over, and the same model on the same
  bytes produced full coverage the moment the rule changed. That failure is the
  dangerous kind, because **what is missing from a summary is invisible to
  whoever reads it**, so the prompt names it explicitly. Answers are asked for in
  Markdown for the same reason: a tier list is a list.
- **The system turn is rebuilt every request, never stored.** A transcript can
  improve underneath a conversation (a better track, a fixed parse); a stored
  copy would freeze it at whatever it looked like on the day it started.
- **The first token is pulled before the response starts.** Once a
  `StreamingResponse` has begun, the status is committed and a failure can only
  end the stream — so a missing key or a dead provider is caught while it can
  still be a 503. The user's turn is saved at that same moment and not before: a
  question sitting in the thread with no answer under it is worse than one that
  never landed.

The wire format is server-sent events: `{"delta": "..."}` per token, then one
`{"done": true, ...}` carrying the span read and whether it was trimmed. Whatever
arrived is saved even when the stream dies — including when the reader closes the
tab, which is why that write happens in the generator's `finally` and the closing
frame is yielded *after* it. Yielding inside that block is a `RuntimeError` during
teardown, and would lose the very partial it exists to keep.

A video with no captions is a **422** rather than an empty answer. The watch page
hides the entry point in that case, so anything reaching here asked directly and
deserves the real reason.

---

## Long summaries in the background (`routers/summaries.py`)

The Ask panel already answers "summarise this video" in two lengths — they are
its two openers. What it cannot do is answer while you are somewhere else, and
that is the whole feature: a forty-minute video takes twenty to thirty seconds
to walk through, which is a long time to sit on a watch page you only opened to
start the job. So the same prompt runs detached, asked for from a card's `…`
menu.

- **The answer lands in the Ask thread**, not in a table of its own. It *is* an
  Ask answer — storing it anywhere else would give you a panel that couldn't see
  the summary and a summary that couldn't be followed up. Both turns are written,
  so the thread reads as the conversation it is. `SUMMARY_QUESTIONS` is kept
  character-identical to the panel's two openers: the same request reaching the
  same model by two routes has to produce the same answer, and a drift there
  would be a bug nobody could see.
- **Both lengths, because they are two requests and not one throttled.** A card
  is exactly where the short one is wanted — *is this worth forty minutes?* — and
  it is also the one where running in the background matters least, which is
  precisely why leaving it out would have been the wrong simplification. The job
  row keeps which was asked for, so the menu can put its spinner on the entry
  that is running rather than on both. A `length` that is neither is a **400**,
  not a fallback: silently reading a typo as "long" bills a 2,500-token answer
  for a three-sentence ask.
- **The job row is the only thing that can report progress.** Nobody is holding a
  stream, so "Summarising" has to be state the server wrote down *before* the
  work started, or a refreshed card has nothing to label itself with. One row per
  (user, video): re-summarising replaces the attempt, because what you want is
  the current summary, not a history of them.
- **A failure fails the job, not the request.** The click happened on a page you
  have probably already left — a 4xx would put the reason in a toast nobody is
  looking at. A video with no transcript, a dead provider and an empty reply all
  end the same way: `status: "error"`, the reason on the row, and a notification
  saying so. (An empty reply is a failure and not a summary on purpose: a blank
  assistant turn reads as *it had nothing to say about this video*, which is a
  different claim from *it didn't answer*.)
- **It gets its own thread pool.** Not `asyncio.to_thread`, and not the default
  executor — the channel scanner runs yt-dlp there, many at a time and for
  minutes each. Measured: a summary that takes 13 seconds alone sat unfinished
  for 95 behind a running scan, with no error and no progress. `routers/local.py`
  and `routers/imported.py` keep their own pools for the same reason.
- **A job still running after `STALE_AFTER` is treated as dead.** Nothing here
  survives a restart, and uvicorn's `--reload` does one most days; without this
  an orphaned row labels its card *Summarising* forever. Decided at read time in
  `_serialize` rather than by a sweeper, since the row is only ever seen through
  there — which also means a stale job never blocks a fresh attempt.

---

## The bell (`routers/notifications.py`)

Background work has a reporting problem: it ends somewhere nobody is looking. The
app already had one surface for saying something and it is the wrong one — a
toast belongs to the request that raised it, vanishes in fifteen seconds, and
only exists in the tab that made the call. A summary started before lunch has to
still be there after it, in whichever tab you open.

So: rows, per user, with a `read` flag rather than a per-user cursor — the badge
shows a count, and a count has to survive the tab closing. The count is computed
over all of them, not just the page returned, because a badge that said 50 when
there were 90 would be a lie in the one number people actually read.

Rows about a video carry a **cover**, copied off the video at write time rather
than looked up on read: the notification has to still render after the video is
unsubscribed, hidden or dropped from the library, and the thumbnail is the
fastest way to recognise which video a row is about — faster than the title
beside it. A row written before the column existed, or about nothing in
particular, has none, and the bell falls back to the kind's icon.

The table is deliberately generic (`kind`, `title`, `body`, optional `video_id`)
even though summaries are the only thing producing rows today. Downloads, imports
and a resync all end the same way and should end up here too.

Opening the bell marks everything read: reading the list *is* reading them, and
there is nothing else to do with a row. A row with a `video_id` opens that video;
a summary row opens it with the Ask panel already showing the answer.

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

### Two kinds of row: `source`

The table holds more than the things you pasted. Opening a video the app has no
row for — which is what the browser extension's *open in YT Feed* button does —
needs the same metadata, because the watch page and the history reporter both
read their title, channel and stats from it. So `GET /api/feed/video/{id}`
resolves an unknown video from YouTube and keeps the result here.

`source` separates the two: `"import"` is something you pasted and meant to
keep, `"youtube"` is a cache of something you opened. `GET /api/imported` lists
only the former — listing the latter would turn a page of things you chose to
keep into a log of everything you clicked.

Pasting the link of a video you'd already opened **promotes** its row to
`"import"` and restamps `created_at`, rather than reporting "already imported"
about something absent from the page.

`POST /api/watch-later/by-id/{id}` — the extension's *save to Watch Later*
button — goes through the same door. It's given an id and nothing else, on
purpose: the alternative is the extension scraping a title and channel name out
of YouTube's markup, which changes. So it calls `get_video` and copies the
snapshot fields off the result, which means a subscribed channel's video costs a
row read and an unknown one is fetched and cached exactly as above. A video that
resolves to nothing — private, deleted, region-blocked — is **not** saved: it
answers `saved: false` rather than putting a blank card on the page.

### The uploader's picture

A video extraction carries no avatar. yt-dlp's `thumbnails` on a video are that
video's own frames — ids `"0"`..`"41"`, no `avatar_uncropped` among them — so
every row written before this had a blank one and drew the fallback initial.

`fill_channel_avatars()` fixes that from the channel instead, cheapest source
first: a channel you're subscribed to already has its picture in `channels` and
costs nothing, and only what's left reaches `channels.list?part=snippet` at one
unit per 50. A whole paste is a single unit. It takes anything carrying
`channel_id` and `channel_thumbnail`, so the same function serves every snapshot
table and the repair script.

**All five snapshot tables carry the column**, and every write path runs it. The
feed pages get the picture joined live from `channels`, so the same `VideoCard`
drew an avatar there and an initial on Watch Later, Downloads and Playlists —
those three had no column to snapshot it into until this. The filler is a no-op
when the caller already sent one, which the app always does; it only reaches for
a channel when the caller couldn't, as the extension's id-only save can't.

Each of the routers imports the **module** (`from app.routers import imported`)
rather than the function, so a test that replaces `fill_channel_avatars` on
`imported` reaches the copy they call.

The 88px (`default`) size is deliberate: it's what all the subscribed channels'
avatars already use, and what these are drawn at. `high` is 800px — an
800-pixel image for a 40-pixel circle.

Best-effort throughout. No credentials, spent quota or a deleted channel leaves
the field blank and the card falls back to its initial. The spend is recorded
against the day but **not** against the archive's share (`archive=False`), so
opening videos can't eat the fetching budget.

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

- **`chat_stream` is a sibling, not a mode.** Async and yielding, where `chat`
  blocks and returns whole. The two are used at opposite ends: a machine caller
  (tagging, translation) can't start until the reply is parsed, so blocking in a
  thread pool is exactly right; a person watching an answer appear cares when the
  first word lands. It defaults `reasoning` **off** for the same reason — thinking
  is invisible to someone staring at an empty panel.

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

## Accounts (`users.py`)

The app was single-user by construction — one OAuth token in a file, one
`subscriptions.yaml`, and every table keyed by a YouTube id with no room for a
second opinion. `users` and `user_channels` are the seam being opened, for a
handful of trusted people sharing one box.

**Nothing reads them yet.** They are populated and correct; the sign-in flow and
the per-user queries come next, and the app behaves exactly as it did until they
land.

### What is shared and what is yours

The split is between a **fact about YouTube** and an **opinion of yours**.
`channels`, `videos`, `imported_videos`, the caption caches and the quota ledger
are catalog and stay global; `watch_history`, `watch_later`, `bookmarks`,
`hidden_channels`, playlists, channel tags and app settings are personal and grow
a `user_id` as they move across. `downloads`, `local_folders` and `local_videos`
are this machine's disk and stay shared on purpose — the group is trusted, the
files are in one place, and per-user isolation there would be ceremony with no
reader.

Sharing the catalog is the whole reason this beats running the app twice: three
people subscribed to the same channel cost one row, one fetch and one tagging
bill, so **API quota is spent per distinct channel rather than per person**. The
scan loop needs no change at all, because it already walks the catalog rather
than a person.

### `user_channels` replaces two things

`subscriptions.yaml`, which was one person's list living in a global file; and
`Channel.source`, which recorded "I added this one by hand" — always a fact about
a person rather than about the channel, and unanswerable once two people
disagree. Both move onto the membership row.

`config/subscriptions.yaml` is still written, as a mirror — it's the file you'd
look at to see what the app thinks you follow, and a hand-editable copy has
rescued more than one bad resync. Nothing reads it back except the migration.
`Channel.source` is likewise still written, because the channel pages read it to
draw their badge; `user_channels.source` is the one the resync prune trusts, and
the one `DELETE /api/channels/{id}` checks — the same channel can be a
subscription to one person and a hand-add to another.

### Every personal row has an owner

`watch_history`, `watch_later`, `bookmarks`, `hidden_channels`, playlists and
channel tags are keyed by `user_id` — so two people watching the same video hold
two rows, resume at two positions, and finish it independently. Tags are the
case worth stating out loud: a tag is an *opinion* about a channel, so two
people can file the same one differently and each sidebar is built from its
owner's answer.

`playlist_items` has no owner of its own. An item belongs to whoever owns the
playlist it's in, and a second copy of that could disagree with it — so every
route naming a playlist id passes through `_owned()` first, and item access is
decided once, in one place. Somebody else's playlist is **404, not 403**: a
refusal would confirm the id exists, which is more than the asker should learn.
The same applies to a bookmark id.

### Importing playlists

A playlist can be copied here from YouTube. `playlists.youtube_id` remembers
which one it came from and `synced_at` when it last pulled; both are empty for a
playlist made here, which is what the Re-sync button keys off.

**The merge is add-only, and that's the whole design.** A video that leaves the
YouTube playlist stays in your copy. This is an import, not a mirror — a sync
that quietly deleted things you'd kept would be a worse tool than one that
occasionally leaves something behind. Because nothing is ever removed, re-syncing
is always safe, which is what lets it be a button rather than a dialog. Importing
a playlist you've already imported re-syncs that copy instead of making a second.

Playlist order survives the copy. There's no position column, and the detail page
sorts newest-first, so the importer spaces `added_at` a second apart descending —
which reproduces YouTube's order exactly. A later re-sync anchors at a later
"now", so videos found afterwards sit above the original import.

**Three ways in, because they reach different things.**

*Listing* (`/youtube`) is bulk and one click, and belongs to the owner alone —
this machine holds a single YouTube token, so listing "my playlists" for anyone
else would hand them the owner's. It costs about one quota unit per fifty videos.
Its limit is narrower than it first looks: `playlists.list?mine=true` returns
playlists that account **created**, and YouTube exposes no endpoint whatsoever
for the playlists you *saved* from other people. That library isn't in the Data
API.

*Naming* (`/youtube/lookup`, then `/import`) is what fills that hole. Both
`playlists.list?id=` and `playlistItems.list` work on **any public playlist**,
owner or not — so a playlist that can't be enumerated can still be pasted. The
lookup is a deliberate two-step, like adding a channel: a link is easy to paste
wrong, and a title plus an owner answers "is this the one I meant?" before
anything is written. `playlist_ref()` takes a playlist URL, a watch URL carrying
`list=`, or a bare id.

*Carrying* (`/import-external`) is the extension's: the videos travel in the
request body, already read off the page as whoever is signed in there. That makes
it the only route to Watch Later, to Liked Videos (YouTube withdrew API access to
both in 2016), and to anyone's **private** playlist — none of which the two paths
above can touch at any price. It's also the only route at all for a household
member with no Google connection. Whose playlist it becomes is decided by the API
key on the request, so nobody can import into someone else's list.

Both paths run the result through `_enrich`, which fills in what the source
didn't carry — durations, view counts, publish dates, uploader avatars. It reads
the local `videos` table **first**, then tops up the rest from the API at a unit
per fifty.

Local-first is not just an optimisation. `batch_fetch_video_stats` keeps an
hour-long cache and returns *nothing* for an id it fetched recently — harmless
for the feed, whose rows already carry their numbers, but an extension import
arrives with none (a playlist page gives up no view count and no publish date),
so a video the scan happened to touch would keep a blank view count for good.

It only ever fills a gap, never overwrites, because a stats answer can come back
partial and replacing a real duration with a zero would be worse than leaving it.

**The title is the one field that overrides rather than fills**, and the reason
is not the obvious one. A playlist page truncates every title to 100 characters,
which is reason enough on its own — but the app asks YouTube for `hl=zh-TW` and
stores the *localized* title, while the page gives whatever language the browser
was in. The two aren't a long and a short version of one string; they're
different strings. "Keep the longer" would put a 100-character English title on
a card sitting beside the Chinese one the feed shows for the very same video.

What the LLM decides about a channel stays shared: `Channel.llm_labels` is a
reading of the channel's own description and topics, the same for everyone, and
re-deriving it per person would spend tokens to reach the same answer. What that
verdict *turns into* — the applied tags, the rejections that suppress them, the
hand-added ones — is per person.

### The feed is your library, not the machine's

`videos` and `channels` are shared catalog — one row however many people follow
the channel — so every read of them has to ask who wants to know. `user_channels`
is that join, and it bounds `GET /api/feed`, `/api/tags/feed`, `/api/channels`
and `/api/feed/statistics`. Following nothing returns an empty feed, not
everything: "no filter" and "no channels" must not collapse into the same answer.

**Search is the same catalog reached a different way.** The Meilisearch indexes
stay shared (a copy per person would be the same documents N times); instead
`channel_id` and `youtube_id` are `filterableAttributes`, and every query carries
`IN [...]` for the asker's channels. An empty set short-circuits to no results
rather than an unfiltered query — that slip would hand somebody the whole
catalog.

A **channel page** is still reachable by id whether or not you follow it. That's
deliberate: it's the preview you land on before deciding to add it, and adding it
would show you the same videos anyway.

### Imported videos: a cache and a list

`imported_videos` was doing two jobs. It's the metadata snapshot for a video the
feed doesn't hold — a **cache**, shared, so the same video costs one yt-dlp fetch
however many people paste its link — and it was also the list of what you
imported, which is **personal**. The list moved to `user_imports`.

A membership table rather than a `user_id` on the snapshot, for the reason the
snapshot's own primary key makes plain: a video is one row, and two people
importing it would otherwise fight over who owns it, the second quietly taking it
off the first's page. So pasting a link somebody already pasted takes the
membership and skips the fetch, and removing an import drops your claim while the
snapshot stays for the watch page and history to read.

### Settings split in two

`app_settings` holds what belongs to the **deployment**; `user_settings` holds
what belongs to a **person**. Each `Spec` declares its `scope`, and `described()`
reports it so the page can mark the switches that change things for everyone.

`archive_fill_enabled` is the case that forced the split: one unattended sweep
spends a daily API quota billed to a single Cloud project, so a per-person copy
would let whoever flipped it last commit everybody's allowance. It stays
`scope="app"`. `youtube_history_sync` is `scope="user"` — one person turning off
the extension's recording must not turn off another's.

### Unfollowing is not deleting

The hinge of the whole thing. Unsubscribing used to delete the channel, its
videos, its tags and its search documents outright: correct with one person in
the app, and one person deleting somebody else's feed once there are two.

So `_prune_channels` does two steps that used to be one. The membership always
goes. The catalog follows only when `users.orphaned_channel_ids` says nobody
holds it any more — which keeps the reclaim (a channel nobody follows is dead
weight) without the collateral. Either way your own saved data survives:
downloads, watch-later and playlist items are snapshots keyed by video id.

Adding a channel someone else already follows costs no fetch at all — the catalog
row exists, so only the membership is taken.

### Adoption: the first sign-in claims the seeded user

There is exactly one person before any of this, and they have no Google `sub`,
because nothing ever asked for one — the old token file carries YouTube access
without saying whose account it is. So `adopt_or_create` claims that unclaimed
row on the first Google sign-in rather than creating a second one beside it,
which is the difference between logging in and finding your history where you
left it, or finding an empty app and a duplicate.

Adoption is guarded on being the **only** user, not merely on the row being
unclaimed: among several people an unclaimed row is ambiguous, and guessing hands
somebody else's watch history to whoever signs in next.

### Signing in (`auth.py`, `auth_google.py`)

`auth_google.py` already did PKCE, consent and the token exchange; it now also
asks **who** that was. Three scopes were added — `openid`, `userinfo.email`,
`userinfo.profile` — and the callback reads Google's userinfo endpoint for the
`sub` claim every personal row will be keyed by. Preferred over decoding the
id_token ourselves: same authority, one less piece of signature-and-clock-skew
handling to get wrong.

**Google sign-in reaches the server and nothing else.** Google accepts an `http`
OAuth callback only on `localhost`/`127.0.0.1`, and a home server answers at
`192.168.something` — an address the Cloud console will not register. So Google
is how *you* sign in, and the rest of the household needs another way; see
"Login links" below.

`ALLOWED_EMAILS` is empty by default, which means **anyone who can reach the app
may have an account**. On a LAN-only deployment the network is the perimeter, and
a list of emails would not be protecting anything the bind address doesn't
already cover — it would just be a list to maintain. Set it only if the app is
reachable more widely than you'd like; someone who already has an account keeps
it even if they later fall off the list, so trimming it can't lock a person out
mid-session.

Two credentials read the caller back, because there are two kinds:

| | carries | who |
|---|---|---|
| `ytfeed_session` cookie | a user id, signed with `SECRET_KEY`, `SameSite=Lax` | the app in a browser |
| `Authorization: Bearer <api_key>` | `users.api_key` | the browser extension |

`GET /api/auth/api-key` returns the caller's own key and has no route to anyone
else's. The extension normally fetches it for itself: its `marker.js` content
script runs on the app's own pages, where the request is same-origin and carries
the session, so opening the app is all it takes. **Settings → Extension** shows
the same key for the cases that can't reach — an app served from an address the
extension has no host permission for.

`Lax` rather than `Strict` because a strict cookie is withheld on the redirect
back from Google's consent screen, which reads as the login silently failing.
The extension can't use the cookie at all: its worker posts from a `youtube.com`
page context, so the cookie would need `SameSite=None` and therefore HTTPS.
Signing out of the browser leaves the API key working — separate credentials for
separate callers.

### One YouTube connection, and whose it is

There are no roles here, deliberately — but one question still needs an answer.
YouTube access is a **single token** in `config/youtube_oauth_token.json`, read
by the scan, the archive fill, the stats fetcher and every resync. Exactly one
account can own it, and the only non-arbitrary choice is the first row
(`users.owner_id`): the person the app belonged to before it could belong to
anyone.

Three things follow, and each of them was a bug first:

- **Signing in writes that file only for the owner.** Otherwise the last person
  to sign in silently repoints the background scan, the archive fill and
  everyone's resync at their YouTube account — and their quota.
- **Only the owner can resync.** The live subscription list comes from that one
  token, so reconciling anyone else's channels against it would prune everything
  they hold that the owner doesn't and hand them the owner's list in exchange.
  `POST /api/subscriptions/resync` refuses with a 400, and the scheduler doesn't
  queue it in the first place — a new account has no `last_resync_at`, so it
  reads as due immediately and an unattended run would have reached it within
  the hour.
- **Adoption listens to the session.** A browser already signed in as a row with
  no Google identity is that row saying "this is me". Without it, the
  only-one-account guard stranded the owner: adding a single family member takes
  the count past one, so the owner's own first Google sign-in would mint a
  third, empty account and leave their library on user 1.

The resync loop is already per-person; per-user resync is waiting on per-user
tokens, not on the loop. Both refusal sites say so.

### Login links (`routers/people.py`)

How everyone else gets in. You add a person under **Settings → People** and send
them a link; opening it signs them in on that device and keeps them signed in.
No password to choose, nothing to configure — which matters, because the people
using this didn't ask for an identity system, they asked to watch videos.

The link **is** the credential, so it is durable rather than single-use (the same
one has to work on a phone, a laptop, and again after a cleared cookie jar) and
regenerable, which is the revocation. Removing the account is the other lever,
and it takes that person's history, playlists, tags and saved videos with it —
the shared catalog and the downloads on disk are untouched.

Two details worth knowing:

- **The API returns the token, not a finished URL.** Requests reach the backend
  through the frontend's dev-server proxy, which doesn't forward the browser's
  `Host` — so anything built here says `localhost:8000`, an address only the
  server can open. The page composes the link from `window.location.origin`,
  which is the address the household actually uses.
- **Adding the first extra person signs the owner in properly**, mid-request.
  Until then they were resolved by the sole-account fallback, and creating a
  second account is the exact moment that fallback stops applying — without it,
  adding a family member would log you out of your own app on the click.

### Who the app answers as

`GET /api/auth/me` answers with two flags rather than one, and never 401s:
`signed_in` means a session cookie or API key named this person; `resolved` means
the app will serve their data, which is also true when nobody is signed in and
the machine has exactly one account (`auth.user_or_sole`). The frontend gates on
`resolved` — that's what decides between showing the app and showing the way in.

### Running the migrations

Two, in order. The first is additive and the second rewrites tables, which is
why they're separate — and why the second is a script you run deliberately
rather than something startup does behind you.

```bash
cp data/youtube_feed.db data/youtube_feed.db.bak
python -m scripts.migrate_multiuser --dry-run
python -m scripts.migrate_multiuser
python -m scripts.migrate_personal_tables --dry-run
python -m scripts.migrate_personal_tables
```

`init_db` refuses to serve a database that has had the first but not the second,
naming the command that fixes it. The migration scripts pass
`init_db(assert_migrated=False)`, because the database they exist to migrate is
exactly the shape that check rejects — with it on, neither script could go first
and an existing install would have no path forward at all — otherwise every personal query would filter on
a column that isn't there, giving a hundred identical `OperationalError`s and no
sign of the one thing that resolves them.

#### 1. `migrate_multiuser` — additive

```bash
python -m scripts.migrate_multiuser --dry-run   # what it would do
python -m scripts.migrate_multiuser             # seed, backfill, move the token
```

**Run it before starting the app** on a database that predates accounts:
`user_channels` is now what the app believes you follow, and an empty one means
an empty feed.

Additive — no existing table is altered and no row is deleted. It seeds you as
user 1, gives you every channel the app already holds (carrying `source` across,
so a hand-added channel stays exempt from the resync prune), moves the refresh
token out of `config/youtube_oauth_token.json` onto your row, and carries the
resync schedule over from `subscriptions.yaml`'s mtime — without that last step
the migrated user reads as "never reconciled" and the destructive prune would run
minutes after the next restart.

Safe to run again: each step is idempotent, so a re-run after subscribing to
something new picks up just that, and the resync clock is only ever set when it's
unset.

#### 2. `migrate_personal_tables` — destructive

Five tables identify a row by a YouTube id alone, which stopped being enough the
moment two people could watch the same video. SQLite has no
`ALTER TABLE ... ALTER PRIMARY KEY`, so each is rebuilt the only way there is:
create the new shape, copy every row, drop the old, rename — all inside one
transaction, so a failure rolls back rather than leaving half a schema.

| table | key before | key after |
|---|---|---|
| `watch_history` | `youtube_id` | `(user_id, youtube_id)` |
| `watch_later` | `youtube_id` | `(user_id, youtube_id)` |
| `hidden_channels` | `channel_id` | `(user_id, channel_id)` |
| `channel_tags` | `(channel_id, tag_name)` | `(user_id, channel_id, tag_name)` |
| `channel_tag_rejections` | `(channel_id, tag_name)` | `(user_id, channel_id, tag_name)` |

`bookmarks` and `playlists` have autoincrement ids, so they only need a column
and are handled by the additive list in `database.py`. Every existing row is
assigned to **user 1**.

Two things ride along with it. Any `scope="user"` preference is moved out of
`app_settings` into `user_settings` — left where it was it would read as unset,
so a switch someone deliberately turned OFF would silently come back on. And
every `source="import"` row in `imported_videos` gets a `user_imports` claim, so
your Imported page still has its contents; the `source="youtube"` rows are cache
and stay unclaimed.

The target shapes are spelled out in the script rather than derived from the
models: a rebuild that read its target from the same place the app does would
happily "migrate" a database into whatever shape today's code wants, which is
how a bad deploy eats data.

Safe to run twice — a table that already has `user_id` is skipped.

The first migration prints your **API key**. That is what the browser extension will
authenticate with — a session cookie can't do that job, because the extension's
worker posts from a `youtube.com` page context and a cookie would need
`SameSite=None` and therefore HTTPS.

> Once the migration has run, `data/youtube_feed.db` holds a Google refresh
> token. It didn't before. If that file lives in a synced folder, that's now a
> credential leaving the machine.

---

## Data model (`models.py`)

| Table | Purpose |
|---|---|
| `users` | one person: their Google `sub`, profile, API key, OAuth refresh token, and when their subscriptions were last reconciled. `google_sub` is empty on the seeded local user until the first sign-in adopts it |
| `user_channels` | who follows which channel, with the `source` (`subscription` / `manual`) that used to sit on `channels` |
| `user_settings` | one person's preferences; `app_settings` keeps the ones that govern shared resources |
| `user_imports` | who pasted which video in — the Imported page's list, with `imported_videos` as the shared metadata behind it |
| `channels` | the channels the feed is built from (id, title, `source`, `last_video_fetched`, `topics`, `llm_labels`, `video_label_vocab` + `video_label_version`, `label_stop_words`). `source` is `subscription` or `manual` — see "Adding a channel by hand", which is the only thing that reads it |
| `videos` | scraped videos (stats, `published_at`, `is_short`, `title_labels`, `last_updated`) |
| `channel_tags` | channel↔tag assignments per user (`auto_assigned`: 1 = LLM, 0 = manual) |
| `channel_tag_rejections` | auto tags a user removed, so their re-tagging won't re-add them |
| `watch_later` | saved-for-later videos, per user (server-side, syncs across devices) |
| `playlists` / `playlist_items` | playlists, owned by a user; items inherit that owner through `playlist_id`. `playlists.youtube_id` + `synced_at` mark one imported from YouTube — see "Importing playlists" |
| `downloads` | videos downloaded to disk for offline viewing |
| `hidden_channels` | channels one user hid from their home feed |
| `imported_videos` | metadata for videos the feed doesn't hold: ones added by URL, plus (under `source="youtube"`) ones opened via the extension's button. A shared cache — `user_imports` says whose page each appears on |
| `watch_history` | how far **each user** got in each video, and whether they finished it |
| `bookmarks` | moments one user marked with `b` while watching — many rows per video, one untyped `video_id` covering YouTube ids and local ones alike |
| `local_folders` | directories browsed as feeds (absolute path + display name) |
| `local_videos` | one video file inside a local folder — cached duration/size/mtime, its own resume position |
| `caption_translations` | AI caption translations, keyed by (video, source lang, target lang) — the one cache worth persisting, since rebuilding costs tokens and minutes |

`watch_later`, `playlist_items`, `downloads`, `imported_videos` and
`watch_history` each store a
**metadata snapshot** of the video so a card still renders even after the video
ages out of the feed window — including `channel_thumbnail`, since the feed's
live join to `channels` isn't available on a page built from a snapshot.
`imported_videos` is deliberately NOT `videos`:
every feed query joins `videos` to the SUBSCRIBED channel set, and an imported
video's channel has no `channels` row, so a row there would be invisible anyway
while polluting the scan and ranking paths. Schema is created by `Base.metadata.create_all`; new columns
are added by the tiny additive-migration list in `database.py`.

---

## Config (`config/`)

- **`subscriptions.yaml`** — a written-only mirror of what you follow.
  `user_channels` is the list itself (see "Accounts"); this is kept because it's
  the file you'd look at to check, and a hand-editable copy has rescued more than
  one bad resync. `POST /api/subscriptions/resync` reconciles your memberships
  against your live YouTube subscriptions: it drops the ones you've unsubscribed
  from, **deleting** a channel's videos, tags, hidden/category entries and search
  docs only if nobody else here follows it, and adds any new ones. Your saved
  data — downloads, watch-later, playlists — is snapshot-keyed by video id and
  left untouched. Preview first with `?dry_run=true`; an empty subscription
  response aborts the prune rather than wiping the DB.
- **`categories.yaml`** — legacy keyword rules that sort each channel into **one**
  feed category (`categorizer.py`). Superseded by the LLM tag system for the
  sidebar; still read by the resync prune when cleaning up removed channels.
- **`youtube_oauth_token.json`** — the Data API token refreshed by the in-app
  "Re-authenticate" link. Stats fall back to yt-dlp if it's missing/expired, so
  OAuth is **optional**. Sign-in now writes the refresh token to the user's row
  **as well as** here; the file stays the source the scanner and stats fetcher
  read, so accounts arrived without touching the scan path.
- **`.env`** (in `backend/`, gitignored) — secrets and switches.
  `OPENROUTER_API_KEY` powers LLM channel tagging; without it, tagging degrades
  to language-only. See "Channel tagging". The tag taxonomy itself lives in code
  (`SEED_TAXONOMY`), not a config file.
  `ARCHIVE_FILL_ENABLED` is only the **bootstrap default** for the archive-fill
  switch; the switch itself lives in Settings → Library and is stored in the DB
  (see "App settings"). Leave it off until you've watched one channel fill from
  its own page and checked the ledger — a library-wide sweep is the first thing
  to exercise the quota-day boundary and cursor resumption against the live API.
  `SECRET_KEY` signs the sign-in cookie — changing it signs everybody out, which
  is also the only revocation this app has. `ALLOWED_EMAILS` is who may sign in
  (see "Accounts"), and `APP_ORIGIN` is where the browser lands afterwards.

### App settings (`app_settings.py`)

Two config systems, split by who the setting belongs to:

- **`.env` / `config.py`** — secrets and environment wiring: API keys, ports,
  paths. Properties of *where the app runs*. Read once at import; changing one
  means restarting.
- **`app_settings.py`** — preferences about *how the app behaves*, stored in the
  database and changeable from the Settings page with no restart. Split by
  `scope`: `user` keys live in `user_settings`, one row per person; `app` keys
  live in `app_settings`, one row for the machine.

Adding a setting is one entry in `SPEC` (key, type, default, label, description,
group, scope). `GET /api/settings` serves the spec alongside the values and the page
renders its controls from it, so a new setting needs no endpoint, no form field,
and no frontend change. Defaults are lazy callables, which is what lets an
`.env` value act as a bootstrap default without becoming a second source of
truth: it seeds the first read and is ignored once a value is stored.

Two settings so far, one of each scope. `archive_fill_enabled` (the nightly
history fill) is **`app`**: one sweep spends a daily API quota billed to a single
Cloud project, so a per-person copy would let whoever flipped it last commit
everybody's allowance. `youtube_history_sync` (whether the extension records what
you watch on youtube.com) is **`user`** — one person turning it off must not turn
off another's — and has no `.env` twin, since it governs an optional browser
extension that's nothing to do with how the server is deployed.

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

- **Comments get a third pool** (`_comment_pool`, 3 workers). A comment walk is
  seconds where a storyboard is a fraction of one, so sharing `_preview_pool`
  would leave hovers queued behind work nobody is looking at. Three is also a
  deliberate ceiling on concurrent paging against YouTube from one address.

- **Every `yt_dlp.YoutubeDL` must be context-managed** — `with ... as ydl:`, not
  `ydl = ...`. Closing it is what returns its connections. The four
  request-scoped call sites (`imported`, `downloads`, `feed` ×2) would survive
  getting this wrong, because the process outlives a request by a lot; the two in
  `fetcher.py` would not, and did not. See below.

### The scan can take the whole machine's network down

Worth knowing by name, because the symptom points nowhere near the cause.

`fetcher.py` ran the scan's yt-dlp without closing it. Each connection to
YouTube stayed in `CLOSE_WAIT` — one per channel, 141 channels, every 15
minutes. After ~17 hours it held **16,350 sockets against an ephemeral range of
16,384** (`net.inet.ip.portrange`, 49152–65535). Once that range is gone, no
process on the machine can open an outbound connection, because there is no
source port left to bind. That includes `curl`, the browser fetching `/api`, and
the backend itself — whose logs filled with

```
[Errno 49] Can't assign requested address
```

against youtube.com, the leak having taken the ports it needed to keep working.

What makes it confusing to diagnose:

- **The servers look fine.** All three processes are alive, and `lsof`/`netstat`
  still show them LISTENing. Nothing crashed. They simply can't be reached.
- **The frontend may still answer** while the backend appears dead — Vite binds
  `host: true` and gets reached over IPv6 (`::1`), which draws from a separate
  pool. That asymmetry is a red herring, not a clue about the backend.
- **`ulimit`/`maxfiles` look healthy.** The exhausted resource is ports, not file
  descriptors, so every limit you'd normally check is well under.

One line tells you whether this is what you're looking at:

```bash
netstat -an -p tcp | grep -c CLOSE_WAIT
```

A handful is normal; thousands means ports are being exhausted. Restarting the
offending process frees them instantly (16,350 → 4). `lsof -nP -iTCP
-sTCP:CLOSE_WAIT` names the culprit if it's something other than the scan.

---

## Key endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/auth/login` | start Google sign-in (redirects to consent) |
| GET | `/api/auth/callback` | exchange the code, admit or refuse the account, set the session, land back at `APP_ORIGIN` |
| GET | `/api/auth/me` | who's signed in — `{"signed_in": false}` when nobody is, never a 401 |
| POST | `/api/auth/logout` | end the session (the extension's API key keeps working) |
| GET | `/api/auth/api-key` | the caller's own bearer token, to paste into the extension's options |
| GET | `/api/users` | everyone with an account here |
| POST | `/api/users` | add a person; returns their `login_token` (the page builds the link) |
| POST | `/api/users/{id}/link` | mint a fresh login token, retiring the old one |
| DELETE | `/api/users/{id}` | remove an account and everything personal in it. Refuses yourself, and the last account |
| GET | `/api/users/join/{token}` | follow a login link — become that person on this device |
| GET | `/api/feed` | ranked feed grouped by category (query: age, sort, tags…) |
| GET | `/api/feed/storyboard/{id}` | hover-scrubbing storyboard frames |
| GET | `/api/feed/captions/{id}` | timed caption cues with per-word segments (query: `lang`; rendered by the frontend) |
| GET | `/api/feed/caption-langs/{id}` | caption languages the video offers (English/中文/日本語/한국어) |
| GET | `/api/feed/captions-translate/{id}` | AI-translate captions to Traditional Chinese — returns whole sentences around a play position (query: `lang` = source track, `at` = seconds, `count` = sentences) |
| GET | `/api/feed/video/{id}` | one video's metadata + `title_labels` (for the in-app watch page / deep links); falls back to the `imported_videos` snapshot, then to resolving it from YouTube and caching it |
| GET | `/api/feed/description/{id}` | one video's description, fetched on demand (never stored) |
| GET | `/api/feed/comments/{id}` | the comment section, fetched only when the panel is opened (query: `sort` = `top`\|`new`, `replies=1` for the slower walk that also brings each thread's replies) |
| GET | `/api/channels/{id}/videos` | a channel's ranked videos + topic chips (`?label=` filters by topic). The channel block carries `source` and `scanning` |
| GET | `/api/channels/lookup?q=` | resolve a channel URL / `@handle` / id and say whether we already hold it. Writes nothing |
| POST | `/api/channels/add` | add that channel by hand, marked `source="manual"` so resync won't prune it. Returns `scanning: true` while its first batch of videos is fetched |
| DELETE | `/api/channels/{id}` | stop following a hand-added channel; its videos go too if nobody else here follows it. 400 for a subscribed one — unsubscribe on YouTube instead |
| GET | `/api/search?q=` | typo-tolerant search (channels + videos), narrowed to the channels you follow |
| GET | `/api/subscriptions` | the channel ids you follow, from `user_channels` |
| POST | `/api/subscriptions/resync` | reconcile your list against live YouTube subscriptions (`?dry_run=true` previews the prune). Owner only — see "One YouTube connection" |
| POST | `/api/channels/{id}/labels/build` | build this channel's video-topic vocabulary (background; `?force=1` rebuilds) |
| GET | `/api/channels/{id}/labels/status` | `{building, built, progress}` for the topic build |
| POST | `/api/channels/{id}/labels/assign` | label the given (rendered) videos against the vocab |
| GET | `/api/tags` | tags in use with per-tag counts (`?include_empty=1` = full taxonomy, for the picker) |
| POST | `/api/tags/auto-assign` | background LLM re-tag of every channel; poll `/api/tags/auto-assign/status` |
| POST/DELETE | `/api/tags/{channel_id}/tag/{tag}` | apply / remove one label on a channel (accept a suggestion / reject an auto tag) |
| GET/POST | `/api/watch-later`, `/api/playlists`, `/api/downloads` | resource CRUD. All three list most-recently-added first and report `created_at` — the date the Watch Later and Downloads pages order *and* window by, since a video's publish date says nothing about when it became yours |
| GET | `/api/playlists/youtube` | the connected account's YouTube playlists, each with the local copy it already has (`linked_id`). Owner only — see "One YouTube connection" |
| GET | `/api/playlists/youtube/lookup?ref=` | preview any **public** playlist by link or id, including one you don't own — what covers the playlists YouTube won't enumerate. Accepts a playlist URL, a watch URL carrying `list=`, or a bare id. Owner only |
| POST | `/api/playlists/import` | copy one YouTube playlist here and remember where it came from. Importing one already imported re-syncs that copy rather than making a second. Owner only |
| POST | `/api/playlists/{id}/resync` | pull anything new from the YouTube playlist this one came from. Add-only |
| POST | `/api/playlists/import-external` | take a playlist the browser read for us — the whole list travels in the body, so no YouTube token is involved. What the extension posts, and the only route to Watch Later, private playlists, and playlists you follow but didn't make |
| POST | `/api/watch-later/by-id/{id}` | save a video we're given nothing but the id of — the extension's button. Metadata is resolved here |
| GET/POST/DELETE | `/api/imported` | imported videos: list / import a paste of links / remove one |
| GET/POST/DELETE | `/api/history` | watch history: list / report a position / forget one. `GET /api/history/{id}` is the resume lookup |
| POST | `/api/history/by-id/{id}` | report a position for a video we're given nothing but the id of — what the extension posts while you watch on youtube.com. Metadata is resolved here |
| GET/POST/DELETE | `/api/hidden-channels` | list / hide / un-hide channels from home |
| GET/POST | `/api/bookmarks` | `GET /api/bookmarks/{video_id}` = one video's marked moments, in playback order; POST adds one. `DELETE /api/bookmarks/id/{n}` removes one |
| GET/POST | `/api/local/folders` | list local folders / add one by path (scans it) |
| GET | `/api/local/folders/{id}/videos` | that folder's videos (`?rescan=false` = cached listing, used by the scanning poll) |
| DELETE | `/api/local/folders/{id}` | forget a folder — our rows and thumbnails only, never the files |
| GET | `/api/local/videos/{id}/file` \| `/thumb` | the file itself (range requests) / its poster frame |
| POST/DELETE | `/api/local/videos/{id}/progress` | record / clear where playback got to |
| POST | `/api/subscriptions/resync` | sync DB to live YouTube subs — prune unsubscribed, add new (`?dry_run=true` to preview). Also runs daily on its own |
| GET | `/api/settings` | every app setting, with the spec the settings page renders itself from |
| PUT | `/api/settings` | partial update: `{"values": {key: value}}`; an unknown key is a 400 |
| GET | `/api/channels/{id}/archive` | how much of this channel's history is held: `held`, `reachable`, `remaining`, `oldest_held`, `exhausted`, `filling` |
| POST | `/api/channels/{id}/archive` | fetch this channel's remaining history in the background (`?units=N` to bound the spend); poll the GET for progress |
| POST | `/api/refresh` | manually trigger a scan (normally the scheduler handles it) |
| GET | `/api/refresh/status` | `{running: bool}` |
| GET | `/api/health` | liveness |

Interactive docs at `http://localhost:8000/docs` when the server is running.

---

## Tests & maintenance

```bash
pip install -r requirements.txt -r requirements-dev.txt
pytest
```

Tests live in `tests/`, under pytest + pytest-asyncio (`asyncio_mode = auto`, so
no per-test decorator). What's covered:

| File | Covers |
|------|--------|
| `test_app_settings.py` | the settings store: bootstrap defaults, unknown keys, and that turning the fill off stops a sweep mid-flight |
| `test_archive.py` | the archive fill: queue order, cursor resumption, budget stops, the 20k ceiling |
| `test_quota.py` | the quota-day boundary (incl. DST), the ledger, and telling an exhausted allowance from a stale token |
| `test_ranking.py` | age ranges, the sort modes, the hot-score burn-in, like% shrinkage |
| `test_history.py` | `is_watched` at both rules' boundaries, upsert, the sticky `watched` flag, the snapshot, and reporting from an id alone: resolved once rather than every ten seconds, and one row shared with the app |
| `test_bookmarks.py` | ordering, per-video scoping, the toggle's clamp, `/id/` not shadowing the video lookup |
| `test_local.py` | the directory walk, path-escape refusal, rescan reconcile, resume |
| `test_playlists.py` | counts, covers, item ordering, cascade on delete |
| `test_playlist_import.py` | the link that makes re-importing a re-sync, playlist order surviving the copy, add-only merge (a video pulled on YouTube stays in your copy), the owner-only guard, every shape `playlist_ref` accepts and rejects, looking up a playlist someone else owns, nothing written before YouTube answers (the write-lock deadlock), and the extension's path: no token, right owner, gaps filled without clobbering what the page already read |
| `test_watch_later.py`, `test_hidden_channels.py` | idempotence, ordering, the bulk import, saving from an id alone, the saved-at stamp, the avatar filled in on save |
| `test_add_channel.py` | every accepted channel reference (id, handle, vanity URL), lookup vs add, idempotence, removal — and that a resync leaves a hand-added channel alone |
| `test_video_labels.py` | match keys, stop words, the verbatim backstop, canonicalization |
| `test_tags.py` | the derived taxonomy maps, language detection |
| `test_captions.py` | sentence grouping, numbered-reply parsing |
| `test_summaries.py` | the summary nobody is watching: the job row written before the work starts, the answer landing in the Ask thread under the panel's own question, each length asking its own question and a third one refused, every failure mode ending as an error on the row plus a notification rather than a 4xx, and a job orphaned by a restart giving up its claim to be running |
| `test_notifications.py` | the bell: newest first, unread until looked at, opening it reading all of them, a row about no video carrying no cover, and one account never seeing or dismissing another's |
| `test_ask.py` | what the model is allowed to see: the timestamped lines, the window that follows the play head on an overlong transcript and admits it was trimmed — plus the streamed reply, a failure that stays an HTTP status, a partial that is kept, and one person's conversation staying theirs |
| `test_comments.py` | nesting yt-dlp's flat list into threads, the two field names it gets wrong (`comment_count` is our cap, not the video's total; disabled vs empty), the sort allow-list, and one cache entry per (video, sort, depth) so the replies walk can't be served the shallow answer |
| `test_categorizer.py` | keyword matching and the `categories.yaml` round-trip |
| `test_imported.py` | every accepted link shape, the Shorts heuristic, publish-date fallbacks, the `source` split (and promotion), resolving an unknown video, avatar lookup |
| `test_users.py` | seeding the person already here, the one-time channel backfill (incl. carrying `source` across), which row a Google account lands on (adoption, its guard, the session claim that keeps the owner from being stranded), the old token file, and the startup migration guard in both directions |
| `test_auth.py` | who `ALLOWED_EMAILS` admits (and who the empty-list fallback does), reading the caller from a cookie or an API key, and the whole sign-in end to end against a stubbed Google |
| `test_isolation.py` | two accounts through the real API, one question per personal table: history, watch-later, bookmarks, hidden channels, playlists, tags, settings, imports and the extension's endpoint — plus 404-not-403 on someone else's playlist or bookmark, the feed/channels/statistics narrowing, and the search filter (including that following nothing searches nothing rather than everything) |
| `test_people.py` | adding a person, the link that signs them in (again, and on another device), retiring one, and that adding the first extra account doesn't log the owner out — plus removal taking their data, refusing the last account, and the three guards around the single YouTube token |
| `test_memberships.py` | following and unfollowing, and the prune's new hinge: a channel someone else still holds survives, the last holder letting go still reclaims it, and one person's list is out of the other's scope |

`conftest.py` redirects `DB_PATH` and `CONFIG_DIR` at a temp directory **before
importing anything under `app`** — `database.py` builds its engine at import
time, so a fixture would be too late and the suite would run against the real
feed. Each test gets an empty schema; the app is driven through httpx's
`ASGITransport`, which doesn't run the lifespan, so the scan scheduler, the
resync loop and the Meilisearch reindex stay out of the way. Nothing reaches the
network: `OPENROUTER_API_KEY` is blanked, and every LLM caller degrades rather
than failing.

Two tests pin behaviour that is currently **wrong**, so a fix is a deliberate
change rather than a surprise — `test_a_mixed_script_japanese_name_is_currently_read_as_chinese`
(with a strict `xfail` next to it stating the intent), and
`test_the_two_rules_cross_over_at_ten_minutes` (whose comment in `history.py`
has the two rules backwards).

`scripts/` holds one-off maintenance scripts (stat backfills, date/count fixes,
subscription import) — run ad hoc, not part of the app. Two of them repair rows
written before the fix that made them unnecessary, and both take `--dry-run`:

```bash
python -m scripts.fix_blank_history    # nameless history rows, via get_video
python -m scripts.fix_channel_avatars  # missing uploader pictures across all five snapshot tables, ~1 unit / 50 channels
```

`scripts/migrate_multiuser.py` and `scripts/migrate_personal_tables.py` are a
different kind of one-off — schema migrations rather than repairs, run once when
accounts arrive, in that order. The second rewrites tables: back the database up
first. See [Accounts](#accounts-userspy).
