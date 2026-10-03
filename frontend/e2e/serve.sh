#!/usr/bin/env bash
#
# The app the e2e suite drives: the built frontend served by a backend of its
# own, on its own port, over a feed made for it (seed.py).
#
# Nothing here touches the real app. The data directory is e2e/.run, wiped on
# every start. Search gets a Meilisearch of its own on another port, over a
# database in there, so the real one isn't written to (without the binary, the
# index points at a port nothing listens on and search.spec skips). Every
# outbound request goes through a proxy that doesn't exist, so a call the specs
# forgot to stub fails fast rather than reaching YouTube. The OpenRouter key is blanked, its home is its
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
MEILI_PORT="${E2E_MEILI_PORT:-7709}"

rm -rf "$RUN"
mkdir -p "$RUN/data"

(cd "$FRONTEND" && npx vite build --outDir "$RUN/dist" --emptyOutDir --logLevel error)

export DATA_DIR="$RUN/data"
# The folder the local-folders spec adds, filled by seed.py.
export E2E_MEDIA_DIR="$RUN/media"
# Every card's thumbnail, made by seed.py and served by fixtures.ts.
export E2E_THUMB="$RUN/thumb.jpg"
export SPA_DIR="$RUN/dist"
export SKIP_CONFIG_ADOPTION=1
export OPENROUTER_API_KEY=""
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

MEILI_PID=""
APP_PID=""
cleanup() { kill $MEILI_PID $APP_PID 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if command -v meilisearch >/dev/null; then
  meilisearch --db-path "$RUN/meili" --http-addr "127.0.0.1:$MEILI_PORT" \
    --env development --no-analytics >"$RUN/meili.log" 2>&1 &
  MEILI_PID=$!
  export MEILI_URL="http://127.0.0.1:$MEILI_PORT"
  for _ in $(seq 1 100); do curl -sf "$MEILI_URL/health" >/dev/null && break; sleep 0.1; done
else
  export MEILI_URL="http://127.0.0.1:9"
fi

cd "$ROOT/backend"
export PYTHONPATH="$ROOT/backend"
.venv/bin/python "$HERE/seed.py"
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$PORT" --log-level warning &
APP_PID=$!
wait $APP_PID
