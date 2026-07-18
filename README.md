# YT Feed

A self-hosted YouTube subscription feed. A backend scrapes your subscribed
channels with yt-dlp, ranks the videos by engagement, and serves a clean
single-page UI whose signature feature is an inline **hover preview** of the
real video (muted, with custom captions and scrubbing).

## Features

- **Custom ranking** — score videos by views/hour, likes, like rate, or recency
- **Time windows** — filter by last 1d / 3d / 1w / 1m / … (each a discrete bucket)
- **Tag filtering** — channels are auto-tagged by an LLM into a topic taxonomy;
  filter the feed by tag, and edit a channel's labels on its page
- **AI categorization** — an LLM (via OpenRouter) reads each channel and assigns
  topic + language labels; needs `OPENROUTER_API_KEY` (see `backend/README.md`)
- **Hover preview** — plays the actual YouTube video inline; click to unmute
- **In-app watch** — click through to a full-bleed player at `/watch/:id` instead
  of leaving for youtube.com; browser back returns you to exactly where you were
- **Shorts** — a separate feed for vertical short-form videos
- **Watch Later / Playlists / Downloads** — all server-side (sync across devices)
- **Search** — typo-tolerant, via a Meilisearch companion
- **Backend-scheduled refresh** — the backend re-scans channels on its own
  interval (default 15 min); the UI just re-reads the results

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 19 + TypeScript + Tailwind v4 + Vite |
| Backend | FastAPI (async) + yt-dlp + SQLAlchemy |
| Storage | SQLite (WAL) for all data; localStorage only for preview volume |
| Search | Meilisearch (optional companion service) |

## Architecture

```
 yt-dlp ──► backend scan ──► SQLite ──► rank ──► FastAPI /api ──► React SPA
           (scheduler,                                              │
            every 15 min)                    hover / watch ─────────┘──► YouTube IFrame
```

A scheduler in the backend re-scans channels every 15 min into SQLite; the
frontend reads `/api/*`. The interesting logic is the **ranking** — a
views-per-hour "hot" score with an early-velocity burn-in, discrete time-window
buckets (wide/narrow), and Bayesian shrinkage on the like-rate sort. See
[backend/README.md](backend/README.md#ranking--feed-shaping-rankingpy).

Component-level detail lives in the per-package READMEs:

- **[backend/README.md](backend/README.md)** — the API, the scan job, the data
  model, and the concurrency decisions (thread + `NullPool` + WAL, bounded
  preview pool).
- **[frontend/README.md](frontend/README.md)** — the SPA, History-API routing,
  and the hover-preview / mute logic.

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

The scanner never re-reads your YouTube subscription list, so subscribe/unsubscribe
changes aren't automatic. Run `POST /api/subscriptions/resync` to reconcile: it
**deletes channels you've unsubscribed from** (and their videos) and adds new ones.
Add `?dry_run=true` to preview the prune first.

## Tests

```bash
cd frontend && npm test
```
