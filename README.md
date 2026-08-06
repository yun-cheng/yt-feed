# YT Feed

A self-hosted YouTube subscription feed. A backend scrapes your subscribed
channels with yt-dlp, ranks the videos by engagement, and serves a clean
single-page UI whose signature feature is an inline **hover preview** of the
real video (muted, with custom captions and scrubbing).

## Features

- **Custom ranking** — score videos by views/hour, likes, like rate, or recency
- **Time windows** — drag a two-handled slider to any span: the last 3 days, or
  3 days to 2 weeks ago
- **Tag filtering** — channels are auto-tagged by an LLM into a topic taxonomy;
  filter the feed by tag, and edit a channel's labels on its page
- **AI categorization** — an LLM (via OpenRouter) reads each channel and assigns
  topic + language labels; needs `OPENROUTER_API_KEY` (see `backend/README.md`)
- **Video topics** — inside a channel, the LLM labels its videos by topic (a
  vocabulary tailored per channel) so you can filter the channel by topic; the
  labels also show on the watch page
- **Hover preview** — plays the actual YouTube video inline; click to unmute
- **In-app watch** — click through to a full-bleed player at `/watch/:id` instead
  of leaving for youtube.com; browser back returns you to exactly where you were.
  Page-level keyboard shortcuts (space/k, m, f, ←/→, j/l, ↑/↓ volume, c, and the
  marks below) and our
  own captions, rendered from the transcript and styled like YouTube's —
  switchable between English / Chinese / Japanese / Korean when offered, with
  dual subtitles and an AI translation into Traditional Chinese
- **Bookmarks & A–B repeat** — `b` marks the moment you're at (saved server-side;
  click the tick to jump back); `[` and `]` set a loop's ends and `\` clears it,
  so a passage replays until you're done with it. Both are drawn on the progress
  bar — ours over a file on disk, and laid over YouTube's own bar on the embed
- **Shorts** — a separate feed for vertical short-form videos
- **Watch Later / Playlists / Downloads** — all server-side (sync across devices).
  A downloaded video plays from disk in that same watch page — no ads, works
  offline — with our own control bar and a scrub preview of the actual frames
- **Watch history** — every video remembers where you stopped: revisiting resumes
  from that timestamp, cards show a red progress bar before you hover, and finished
  videos get a "Watched" badge. All of it on its own History page
- **Watch status filter** — a sidebar section for unwatched / in progress / watched;
  the home feed excludes watched by default, so it's about what you haven't seen
- **Imported videos** — paste any YouTube link to add a one-off video from a
  channel you don't follow; it lands on its own page that looks and behaves
  exactly like the home feed (watch, download, playlist, watch later)
- **Local folders** — point the app at a directory on the backend's machine and
  its video files become their own feed: poster frames, durations, hover previews
  and resume, played in the same control bar downloads use. Each folder stays a
  separate page; files are only ever read
- **Search** — typo-tolerant, via a Meilisearch companion
- **Backend-scheduled refresh** — the backend re-scans channels on its own
  interval (default 15 min); the UI just re-reads the results

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 19 + TypeScript + Tailwind v4 + Vite |
| Backend | FastAPI (async) + yt-dlp + SQLAlchemy |
| Storage | SQLite (WAL) for all data; localStorage for preview volume + caption prefs |
| Search | Meilisearch (optional companion service) |

## Architecture

```
 yt-dlp ──► backend scan ──► SQLite ──► rank ──► FastAPI /api ──► React SPA
           (scheduler,                                              │
            every 15 min)                    hover / watch ─────────┘──► YouTube IFrame
```

A scheduler in the backend re-scans channels every 15 min into SQLite; the
frontend reads `/api/*`. The interesting logic is the **ranking** — a
views-per-hour "hot" score with an early-velocity burn-in, time windows named by
both their edges, and Bayesian shrinkage on the like-rate sort. See
[backend/README.md](backend/README.md#ranking--feed-shaping-rankingpy).

Component-level detail lives in the per-package READMEs:

- **[backend/README.md](backend/README.md)** — the API, the scan job, the data
  model, and the concurrency decisions (thread + `NullPool` + WAL, bounded
  preview pool).
- **[frontend/README.md](frontend/README.md)** — the SPA, History-API routing,
  and the hover-preview / mute logic.
- **[extension/README.md](extension/README.md)** — the optional clean-embed
  extension: what it hides, how the app detects it, and the one selector it
  rests on.

## Setup

Run three processes. The frontend dev server proxies `/api` → `localhost:8000`.

### Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Search (optional)

```bash
meilisearch --db-path data/meili --http-addr 127.0.0.1:7700 --no-analytics
```

If Meilisearch isn't running, search returns nothing and everything else works.
All three are also defined in [`.claude/launch.json`](.claude/launch.json).

### Clean embed (optional)

A companion browser extension strips YouTube's overlays — title, avatar, centre
play button, share row, "More videos" — off embedded players, so the app draws
its own control bar over bare video. Load `extension/` unpacked from
`chrome://extensions` (Developer mode → Load unpacked) and reload the app.

Everything works without it; the app keeps YouTube's own controls and lays the
bookmark / A–B marks over them instead. See
[`extension/README.md`](extension/README.md).

### AI tagging (optional)

LLM channel tagging needs an [OpenRouter](https://openrouter.ai) key in
`backend/.env`:

```bash
echo 'OPENROUTER_API_KEY=sk-or-v1-...' >> backend/.env
```

Without it, channels are tagged by language only. See
[`backend/README.md`](backend/README.md#channel-tagging-routerstagspy-llmpy).

## Channels

Subscribed channels live in `backend/config/subscriptions.yaml` — import them via
the in-app Google OAuth flow (`/api/auth/login`) or edit the file by hand. The
backend scheduler picks up new channels on its next scan; you can also force one
with `POST /api/refresh`.

The 15-minute scan only walks channels already in the DB. Reconciling against your
live YouTube subscriptions is a separate job that runs **once a day**: it
**deletes channels you've unsubscribed from** (and their videos) and adds new ones.
`POST /api/subscriptions/resync` forces one by hand; add `?dry_run=true` to preview
the prune first.

## Tests

```bash
cd frontend && npm test
```

```bash
cd backend && pip install -r requirements-dev.txt && pytest
```

The backend suite runs against a temp SQLite file, never your real feed, and
makes no network calls. See each side's README for what's covered.
