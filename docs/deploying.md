# Deploying YT Feed

The short version is in the [root README](../README.md#deploy-it-yourself):
clone, `docker compose up -d`, read the claim link out of the log. This is the
rest — the parts that only matter once, and the one part that may not work.

## What runs

One container, and optionally Meilisearch beside it.

The app image holds the FastAPI process, the 15-minute scan scheduler, the daily
subscription resync, and the built frontend, which that same process serves. One
container rather than two because they are one thing at this size: the schedulers
live *inside* the API process, guarded by a module-level flag
([`_refreshing`](../backend/app/main.py)), and splitting them out would buy a
second thing to keep running and a CORS configuration to get wrong.

Which is also why the image runs **one** uvicorn worker, and why scaling this
horizontally is not a thing you can do without changing the app. Two workers
would run two copies of the scan against one SQLite file.

Serving the SPA from the API process means the app is one origin. No CORS, one
port to publish, and — the part that saves the most trouble — the Google OAuth
callback lands on the address people actually typed, so the one redirect URI you
register is the one that gets used.

## The volume

`/data` holds everything the app writes:

```
/data
  youtube_feed.db     the feed: channels, videos, history, playlists, tags
  config/             the OAuth token, subscriptions.yaml, categories.yaml,
                      youtube_cookies.txt
  downloads/          videos you saved for offline
  local_thumbs/       poster frames from local-folder videos
  asr-audio/          scratch; deleted per job
  secret_key          generated on first boot; signs the session cookie
  setup-token         the claim token
```

Back up the volume and you have backed up the deployment. `docker compose down`
without `-v` keeps it; `docker compose down -v` **deletes the feed**, and there
is no undo — the videos are gone and the next scan re-fetches them from zero.

Meilisearch gets its own volume, and that one is derived: the indexes are rebuilt
from the database on every startup, so losing it costs one reindex.

`DATA_DIR` moves the lot. Locally it defaults to `./data`, which is where an
existing checkout already keeps its database.

### Upgrading from a pre-container checkout

Config used to live in `backend/config/`, inside the repository. On first boot the
app **copies** `subscriptions.yaml`, `categories.yaml` and
`youtube_oauth_token.json` forward into `$DATA_DIR/config/` and says so in the
log. Copies, not moves, so an older build of the app still starts and so this step
cannot be the one that loses your subscription list. Once the new deployment has
been up and works, the originals in `backend/config/` are yours to delete.

## Google OAuth

Needed only to sign in with Google and import your subscriptions. Without it you
still have an account — the claim creates one — and you add channels by hand.

1. Google Cloud console → **APIs & Services**.
2. Enable the **YouTube Data API v3**.
3. **Credentials → Create credentials → OAuth client ID**, type **Web
   application**.
4. Under **Authorized redirect URIs**, add your address plus
   `/api/auth/callback`. Every address people might reach the app at needs to be
   here, because the callback is derived from the request rather than hardcoded —
   see [`_redirect_uri`](../backend/app/auth_google.py).
5. Paste the client ID and secret into **Settings → Connections** (or into the
   claim form on first run).

**Google only accepts `http` for `localhost` and `127.0.0.1`.** A private LAN
address over plain http is rejected in the console, which is why Google sign-in
on a LAN works for the machine running the server and nobody else. Behind https
with a real hostname there is no such limit.

## Reverse proxy and TLS

The container speaks plain http on 8000. Put whatever you already use in front of
it — Caddy, nginx, Traefik, or a platform that terminates TLS for you.

Set `PUBLIC_URL` to the address people type, with its scheme. Two things turn on
it, and both failures are quiet:

- the session cookie is marked `Secure` when it is https. On plain http a
  `Secure` cookie is never stored, so sign-in appears to do nothing at all; not
  setting it behind https means the cookie is allowed to travel in clear.
- it is where the app sends a browser after signing in.

A minimal Caddyfile:

```
feed.example.com {
    reverse_proxy localhost:8000
}
```

## Who can sign in

A fresh deployment is **unclaimed**: nobody owns it, and until somebody does,
nothing can be configured and nobody can sign in. The claim token is printed to
the log on first boot, because the log reaches the person who ran the container
and the open port reaches everybody. It stops being accepted the moment an
account exists, so there is nothing to rotate.

After that, admission is **closed** by default. You invite people from
**Settings → People**, which mints a link that signs them in and creates their
account; it works on as many devices as they like, and can be regenerated.

Two overrides:

- `OPEN_SIGNUP=true` — anyone who can reach the server may sign in with Google.
  This was the default before this app could be deployed anywhere but a home
  network, and on a home network it is still right: the perimeter is real, and a
  list of emails would stand between a family member and the app they were told to
  use. On a public URL it hands the app to whoever finds it.
- `ALLOWED_EMAILS=a@x.com,b@y.com` — an explicit list, which is then the whole
  answer.

Somebody who already has an account keeps it under every setting, so tightening
the rules never locks out the people already using it.

`SECRET_KEY` is generated into the volume on first boot, so no deployment ships
with a key its author knows — a published default would let anyone forge a signed
cookie. Set it yourself only to share one key deliberately across instances.

## When YouTube refuses

This is the failure most likely to spoil a hosted deployment, and it is worth
knowing before you choose where to host.

yt-dlp is not a fallback here: it is how the scan reads channels, how the hover
preview and the watch page get their streams, how captions and storyboards and
comments arrive, and how downloads work — nine call sites across five modules,
reached from most of the app. It talks to youtube.com the way a browser does. And requests from datacenter IP ranges are answered with
*"Sign in to confirm you're not a bot"* far more often than requests from home
connections.

From inside the app this does not look like being blocked. It looks like channels
with no new videos, previews that never load, a download stuck at "error". So the
cookies field in **Settings → Connections** carries a live status line that says
whether extraction is getting through, and names a bot check as a bot check.

Two levers, both in Settings → Connections:

**Cookies.** Export `cookies.txt` from a browser signed in to YouTube and paste
the file in. This is what usually works.

> ⚠ Cookies are a **full session** for that Google account — far more than the
> `youtube.readonly` scope that signing in to this app grants. Replaying them from
> a datacenter address is a known way to get an account flagged or locked. Use a
> throwaway Google account, never your main one.
>
> There is no way to make yt-dlp use the app's OAuth token instead. That token
> opens `googleapis.com/youtube/v3`, the Data API, which is a different service:
> it has no endpoint for media streams or storyboards, and `captions.download`
> only works on videos you own. youtube.com's own player endpoints authenticate
> with a cookie-derived hash and accept no OAuth bearer token; yt-dlp's only auth
> options are `--cookies`, `--cookies-from-browser` and `-u/-p`.

You can also drop a `cookies.txt` into `$DATA_DIR/config/youtube_cookies.txt`
directly, without going through the form. Nothing overwrites it unless the
setting is written.

**A proxy.** `YOUTUBE_PROXY`, or the field in Settings. A residential proxy is
usually what works where a datacenter address doesn't. Worth setting as an
environment variable rather than in the UI if you want it in place before the
first scan, which starts 30 seconds after boot.

**Or host it at home.** A box on your own connection — a NAS, a Pi, an old
laptop — has none of this problem, and the same `docker compose up` runs there.

## Local video folders

The local-folder feature indexes video files from disk. In a container it can only
see what you mount, so uncomment the bind in `compose.yaml`:

```yaml
    volumes:
      - ytfeed-data:/data
      - ./media:/media:ro
```

Read-only, because this app indexes and plays those files and never writes them.
Add the folder in the app as `/media/...`.

## Speech-to-text

Absent from the image, on purpose. The transcription path uses `mlx-whisper`,
which is Apple-Silicon only and pulls ~500MB of torch plus ~1.5GB of model
weights — a lot to inflict on a server that may never transcribe anything.
`asr.available()` gates the whole feature and the watch page simply doesn't offer
it where the answer is no. It works in a local checkout on a Mac:
`pip install mlx-whisper opencc-python-reimplemented`.

## Updating

```bash
git pull && docker compose up -d --build
```

The schema migrates itself on startup — additive columns only, see
`_COLUMN_MIGRATIONS` in [`database.py`](../backend/app/database.py) — and the
volume is untouched, so settings, accounts and history survive.

## Checking a deployment came up right

```bash
scripts/smoke-deploy.sh
```

Builds the image, starts it against an empty volume on its own project name and
port, and asserts the things that have to be true of a *fresh* deployment: the
SPA is served, a client-side route reloads, an unknown `/api` path is still a
404, the claim link reaches the log, a stranger cannot write settings, the second
claim is refused, and a stored key does not come back out of the API. Tears
itself down either way, and touches neither your `data/` nor a running dev
server.

## Running without Docker

Three processes; the frontend dev server proxies `/api` to the backend. See
[Setup (from source)](../README.md#setup-from-source). The same
`DATA_DIR`, claim flow and Settings apply — Docker is a convenience here, not a
requirement.
