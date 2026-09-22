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
  filter the feed by tag, and edit a channel's labels on its page. Each chip is
  split — its body shows only that tag, the `−` beside it hides that tag — so
  "Chinese" and "not Chinese" are one click each
- **AI categorization** — an LLM (via OpenRouter) reads each channel and assigns
  topic + language labels; needs `OPENROUTER_API_KEY` (see `backend/README.md`)
- **Video topics** — inside a channel, the LLM labels its videos by topic (a
  vocabulary tailored per channel) so you can filter the channel by topic; the
  labels also show on the watch page
- **Focus mode** — a toggle in the control bar: the bar then follows the cursor
  and nothing else, so pausing or seeking by keyboard leaves the picture clean.
  Move the mouse onto the video to bring it back
- **Summarised filter** — a chip in the sidebar that narrows any list of videos
  to the ones you've had a summary written for, on the feed, a channel, History,
  Watch Later, Imported and playlists
- **Filter presets** — name the sidebar selection you've built and put it back
  on with one click. A preset is a filter set and nothing else — no page, no
  sort — so the same one works on the feed, History or Watch Later, the three
  pages with the full set of filters. Click it again to take it off; leaving
  the page takes it off too
- **Hover preview** — plays the actual YouTube video inline; click to unmute
- **Live streams** — a broadcast on air gets a LIVE pill in place of the clock,
  red at the edge and grey once you've fallen behind; click it to jump back to
  live. The track is the elapsed broadcast, so you can scrub back into it —
  and where you paused is remembered, so a refresh returns you there rather than
  to the edge. Watching live never marks the stream watched
- **In-app watch** — click through to a full-bleed player at `/watch/:id` instead
  of leaving for youtube.com; browser back returns you to exactly where you were.
  Page-level keyboard shortcuts (space/k, m, f, ←/→, j/l, ↑/↓ volume, c, p, and
  the marks below) and our
  own captions, rendered from the transcript and styled like YouTube's —
  switchable between English / Chinese / Japanese / Korean / Thai / Vietnamese
  when offered, with dual subtitles, an AI translation into Traditional Chinese, and a top/bottom
  position and font size the embed's own captions would never give you
- **Bookmarks & A–B repeat** — `b` marks the moment you're at (saved server-side;
  click the tick to jump back); `[` and `]` set a loop's ends and `\` stops it,
  so a passage replays until you're done with it. **One end is enough**: `[` alone
  repeats from there to the end of the video, `]` alone from the start up to
  there. **A video keeps as many passages as you mark**, saved with it — the loop
  button opens the list, where you switch between them, delete one, or start a
  new one from where you are. Both show on the progress bar —
  a bookmark as a tick in the track, the loop as the bar itself: its ends notch
  the track and everything outside the loop dims back. Both also have a **button
  in the control bar**: the loop's opens that list of passages, and the
  bookmark's fills in and offers to clear the mark whenever you're standing on
  one. It's our own bar over a file on disk, and a
  rail laid over YouTube's own bar on the embed
- **Up next, in the channel's own order** — when a video ends, the card offered
  is the same channel's **next one forward in time**, which is the order YouTube's
  own up-next never gives you and the one that lets you work through a backlog.
  It follows whatever narrowed the page you came from: pick a topic, a time
  window, or "unwatched" on a channel, and the chain stays inside that list.
  The same video is a **next button in the control bar** for when you don't want
  to sit through the rest — hover it and you see where you'd be going
- **Ask AI** — a conversation about the video you're watching, answered from its
  own transcript: it cites the moment it read, and those timestamps are buttons that
  seek there. Because it only knows this video, it can say "that isn't in here"
  rather than answering about the subject in general. Shares the right-hand panel
  with the transcript, one tab each, and streams the reply as it's written
- **Summaries written in the background** — ask any card's `…` menu for a **short**
  or a **long** one and walk away. The card labels itself **Summarising**, then **Summarised**, and
  the **bell** at the top right says when it landed; clicking that opens the video
  with the summary already in its Ask panel, where you can keep asking
- **Shorts** — a separate feed for vertical short-form videos
- **Per-video volume boost** — some videos are mixed so quietly that 100% isn't
  enough, and raising the shared volume just makes the next one shout. A second
  volume control in the bar amplifies **this video only**, up to 8× — through a
  limiter, so the extra range makes quiet dialogue louder instead of making loud
  parts crackle — and resets when you move on. Downloaded files and local folders it amplifies directly;
  on a YouTube embed the audio is out of the page's reach, so the extension does
  it from inside the player's own frame
- **Watch Later / Playlists / Downloads** — all server-side (sync across devices).
  A downloaded video plays from disk in that same watch page — no ads, works
  offline — with our own control bar and a scrub preview of the actual frames
- **Playlists imported from YouTube** — bring a playlist over and it keeps a link
  back, so a Re-sync button pulls anything new. Never anything out: your copy is
  yours, so re-syncing is always safe. The Playlists page lists the ones your
  connected account made, and takes a pasted link for any public playlist besides
  — including other people's, which YouTube will happily *read* but won't
  *enumerate*. The extension's button on any playlist page reaches what's left:
  Watch Later, Liked Videos and private playlists, for everyone in the household,
  connected account or not
- **Undo a removal** — taking a video off History, a playlist or Imported, or
  deleting a download, says so in the corner and offers to take it back for ten
  seconds. What comes back is the row itself, not a fresh copy of it: a history
  row keeps its resume point and its "Watched" badge, and a playlist item goes
  back to its place in the list rather than to the top. A deleted download is
  the one exception — the file is gone, so undoing fetches it again
- **Reachable on a phone** — the app is built for a desktop and a keyboard, and
  that hasn't changed; what's promised on a small screen is only that nothing is
  *unreachable*. Below 768px the sidebar becomes a drawer carrying every
  destination, a bottom bar holds the four you use most, the player gets a back
  button, and a control that only appeared on hover now stays put where there is
  no pointer to hover with
- **Watch history** — every video remembers where you stopped: revisiting resumes
  from that timestamp, cards show a red progress bar before you hover, and finished
  videos get a "Watched" badge. All of it on its own History page
- **Search in a list** — on History, Watch Later, Downloads, Imported or a
  playlist, the search box's "In history" / "In this playlist" / … button turns
  it into a filter for that page, by title or channel name, alongside the page's
  window, sort and sidebar filters, the way "In this channel" works on a channel
  page. The Channels page filters as you type, by channel name or topic, with no
  button to press first — typo-tolerant like the rest, and sorted by how well the
  name answers what you typed
- **Watch status filter** — a sidebar section for unwatched / in progress / watched;
  the home feed excludes watched by default, so it's about what you haven't seen
- **Your own page defaults** — Settings → Pages sets the time window, sort and
  watch filter each page opens on (Home's past-3-days-by-likes, for one), with
  the same slider and sort buttons the page itself shows. Links and reloads
  follow your defaults too
- **Six languages** — Settings → Language switches the app's own text between
  English, 繁體中文, 日本語, 한국어, ไทย and Tiếng Việt, and
  follows the browser until you pick. The same section sets the caption language
  (and an optional second track) every video opens with, and the language a
comment's Translate button translates into, all saved to your account
- **Imported videos** — paste any YouTube link to add a one-off video from a
  channel you don't follow; it lands on its own page that looks and behaves
  exactly like the home feed (watch, download, playlist, watch later)
- **Open from YouTube** — with the extension installed, hovering any thumbnail on
  youtube.com puts three buttons on its corner: open that video here instead,
  save it straight to Watch Later, or drop it into one of your playlists (or a
  new one, named on the spot) — without leaving the page. Already-saved videos show a tick before you click. Whatever you send
  over gets its title, channel and stats resolved on arrival, and stays off the
  Imported page — that page is what you chose to keep
- **Watch history from YouTube** — the extension also reports what you watch *on*
  youtube.com, so a video you started there keeps its place here: same progress
  bar, same resume point, same History page. One direction only; YouTube offers
  nothing to write history back into. A switch on the Settings page turns it off,
  and the extension stops watching rather than merely stops being listened to
- **Local folders** — point the app at a directory on the backend's machine and
  its video files become their own feed: poster frames, durations, hover previews
  and resume, played in the same control bar downloads use. Each folder stays a
  separate page; files are only ever read
- **Search** — typo-tolerant, via a Meilisearch companion. From a channel page
  the box can be confined to that channel: it filters the page you're on, so the
  window, the topic chips and the watch filters keep working on what it finds.
  The sort goes to Relevance while the search runs, and back to yours when it
  ends
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
- **[extension/README.md](extension/README.md)** — the optional companion
  extension: the *open in YT Feed* button on YouTube's video cards, what it
  hides on embedded players, and the one selector that rests on.

Investigations that shaped a decision, kept so it isn't relitigated:

- **[docs/youtube-history-writeback.md](docs/youtube-history-writeback.md)** —
  why watch history travels YouTube → app and never back, with the four routes
  that were measured and what each one hit.

## Deploy it yourself

```bash
git clone https://github.com/yun-cheng/yt-feed.git && cd yt-feed
docker compose up -d
docker compose logs app | grep setup
```

That last line prints a link with a one-time token in it. Open it, claim the
deployment, and you are its owner — after which nobody else can sign in unless
you invite them from **Settings → People**.

Then fill in what you want under **Settings → Connections**. Nothing there is
required to get a feed:

| | what it turns on | without it |
|---|---|---|
| **OpenRouter key** | channel/video tagging, caption translation, summaries, Ask | channels are tagged by language alone |
| **Google OAuth client** | sign in with Google, import your subscriptions | add channels by hand |
| **YouTube cookies / proxy** | getting past the bot check on a hosted address | see below |
| **Meilisearch key** | only for an external Meilisearch | the bundled one needs no key |

The keys live in the database, not in a file, so there is nothing to create
before the app will start. The matching `.env` variables still work as
bootstrap defaults if you prefer files — see [`.env.example`](.env.example).

One volume holds everything the app writes: the database, downloads,
thumbnails, the OAuth token and the generated session key. Backing that up is
the whole backup story.

**On a public address, set `PUBLIC_URL`.** It marks the session cookie `Secure`
(on plain http a `Secure` cookie is never stored, so sign-in appears to do
nothing) and it is where Google returns you after signing in. On a LAN, where
the network is already the perimeter, `OPEN_SIGNUP=true` lets anyone who can
reach the server have an account — which is how this app behaved before it could
be deployed anywhere else.

**A hosted address may get refused by YouTube.** Datacenter IP ranges are asked
to "confirm you're not a bot" far more often than home connections, and yt-dlp
is what the scan, the previews, the captions and the downloads all go through.
Settings → Connections takes a cookie jar or a proxy to answer that, and the
line under the cookies field says whether extraction is currently getting
through. A machine at home remains the reliable host. Full detail, including the
account-safety caveat on cookies, is in **[docs/deploying.md](docs/deploying.md)**.

Speech-to-text is absent from the image on purpose: `mlx-whisper` is
Apple-Silicon only, so the feature offers itself only where it can run.

## Setup (from source)

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

### Browser extension (optional)

A companion extension does two things, each on a different site. On **youtube.com**
it puts *open in YT Feed*, *save to Watch Later* and *save to a playlist* buttons
on the corner of every video thumbnail, so a video you find there opens — or is
kept — here instead, styled to pass for YouTube's own circular hover controls; it adds a
channel to the feed from that channel's page, and reports what you watch there
into the app's watch history. On
**embedded players** it strips YouTube's overlays —
title, avatar, centre play button, share row, "More videos" — so the app draws
its own control bar over bare video, and it amplifies a too-quiet player past
100% on the app's ask, which only something inside that frame can do.

Load `extension/` unpacked from `chrome://extensions` (Developer mode → Load
unpacked), open its **Extension options** and paste the API key from the app's
**Settings → Extension**, then reload the app. The key says whose history and
Watch Later the buttons reach; on a machine with one account you can leave it
empty.

Everything works without it; the app keeps YouTube's own controls and lays the
bookmark / A–B marks over them instead. A video opened with the button need not
be from a channel you follow — the watch page resolves and caches whatever it's
never seen. See [`extension/README.md`](extension/README.md).

### Sharing it with the household

The dev server already listens on every interface, so anyone on your network can
open `http://<your-machine>:5173`. Add them under **Settings → People** and send
them the link it gives you — opening it signs them in and keeps them signed in.
Everyone keeps their own history, playlists, tags and saved videos; the channels,
videos and downloads are shared, so a channel two people follow is fetched once.

**The links are how people get in, and by default the only way.** Signing in
with Google admits nobody who wasn't invited — which starts mattering the moment
this app is reachable at an address you didn't choose. `OPEN_SIGNUP=true` restores
the older behaviour, where anyone who could reach the server could have an
account: the right setting for a LAN, where the network is already the perimeter,
and the wrong one for a public URL. `ALLOWED_EMAILS` names people explicitly
instead.

Google sign-in also only works where Google will send the browser back: it
accepts an `http` callback on `localhost` and nowhere else, so on a LAN it is for
whoever runs the server and the links are for everyone else. A deployment behind
https has no such limit.

The YouTube connection itself stays yours. It's a single token this app holds,
and the scan, the archive fill and the subscription resync all run on it — so
those are the owner's, and a family member signing in with Google can't repoint
them. What everyone else gets is the shared library plus their own everything
on top of it; they add channels by hand rather than importing subscriptions.


### AI tagging (optional)

LLM channel tagging needs an [OpenRouter](https://openrouter.ai) key. Paste it
into **Settings → Connections** — there is a **Test** button next to it — or set
`OPENROUTER_API_KEY` in `backend/.env` if you'd rather keep it in a file. A
stored key wins over the file; see
[`backend/app/runtime_config.py`](backend/app/runtime_config.py).

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

**You can also add a channel you're not subscribed to** — from the *Add channel*
button on the Channels page, from the pill the browser extension puts on a
YouTube channel page, or from the channel page of a video's uploader when the app
doesn't hold them yet. Paste a link, an `@handle` or a bare id. Such a channel is
marked `manual`, which is what keeps the daily resync from deleting it again; in
every other respect it's an ordinary channel, so it's scanned, tagged, ranked and
eventually archived like the rest. `DELETE /api/channels/{id}` (or the remove
button on its card) takes it back out.

## Tests

```bash
cd frontend && npm test
```

```bash
cd backend && pip install -r requirements-dev.txt && pytest
```

The backend suite runs against a temp SQLite file, never your real feed, and
makes no network calls. See each side's README for what's covered.

There is a third, for the seam neither suite can reach — an image, a volume, and
a process that has never run before:

```bash
scripts/smoke-deploy.sh
```

It builds the image, brings it up against an empty volume on its own project
name and port, and checks that a fresh deployment serves the app, reports itself
unclaimed, refuses to be configured by a stranger, and hands its owner a key that
cannot be read back out. It removes its own containers and volumes on the way
out, and never touches your `data/` or a running dev server.
