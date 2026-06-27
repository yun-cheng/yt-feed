# YT Feed

A self-hosted YouTube subscription feed. Pulls videos from your subscribed channels via yt-dlp, ranks them by engagement, and serves a clean mobile-first UI.

## Features

- **Custom ranking** — score videos by views/hour, likes, like rate, or recency
- **Tag filtering** — group channels by topic and filter the feed by tag
- **Watch Later** — bookmark videos; persisted in localStorage
- **Time windows** — filter by last 1d / 3d / 1w / 1m / etc.
- **Mobile-first** — single-column layout, bottom nav, topbar hides on scroll
- **Auto-refresh** — background fetch every 5 min when tab is active

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 19 + TypeScript + Tailwind v4 + Vite |
| Backend | FastAPI + yt-dlp |
| Storage | SQLite (videos) + localStorage (Watch Later) |

## Setup

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend dev server proxies `/api` to `localhost:8000`.

### Add channels

Edit `backend/channels.txt` (or however channels are configured) with YouTube channel IDs, one per line. Then hit the refresh button in the UI or `POST /api/refresh` to fetch videos.

## Running tests

```bash
cd frontend
npm test
```
