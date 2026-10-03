#!/usr/bin/env bash
#
# The app the e2e suite drives: the built frontend served by a backend of its
# own, on its own port, over a feed made for it (seed.py).
#
# Nothing here touches the real app. The data directory is e2e/.run, wiped on
# every start. The search index points at a port nothing listens on, so the
# real Meilisearch isn't written to. Every outbound request goes through a
# proxy that doesn't exist, so a call the specs forgot to stub fails fast
# rather than reaching YouTube. The OpenRouter key is blanked, its home is its
# own (so the real ~/.hermes OAuth client is out of reach), and the
# scheduled channel scans never come round.
#
# Started by Playwright (playwright.config.ts → webServer), which stops it after.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND="$(dirname "$HERE")"
ROOT="$(dirname "$FRONTEND")"
RUN="$HERE/.run"
PORT="${E2E_PORT:-8765}"

rm -rf "$RUN"
mkdir -p "$RUN/data"

(cd "$FRONTEND" && npx vite build --outDir "$RUN/dist" --emptyOutDir --logLevel error)

export DATA_DIR="$RUN/data"
# The folder the local-folders spec adds, filled by seed.py.
export E2E_MEDIA_DIR="$RUN/media"
export SPA_DIR="$RUN/dist"
export SKIP_CONFIG_ADOPTION=1
export OPENROUTER_API_KEY=""
export MEILI_URL="http://127.0.0.1:9"
export MEILI_MASTER_KEY=""
export SCAN_STARTUP_DELAY_SECONDS=999999999
export RESYNC_STARTUP_DELAY_SECONDS=999999999
export HTTP_PROXY="http://127.0.0.1:9" HTTPS_PROXY="http://127.0.0.1:9" ALL_PROXY="http://127.0.0.1:9"
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" all_proxy="$ALL_PROXY"
export NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"
# A home of its own: the OAuth client is read from ~/.hermes, and this server
# shouldn't find the real one (or write yt-dlp's cache into the real ~/.cache).
mkdir -p "$RUN/home"
export HOME="$RUN/home"

cd "$ROOT/backend"
export PYTHONPATH="$ROOT/backend"
.venv/bin/python "$HERE/seed.py"
exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$PORT" --log-level warning
