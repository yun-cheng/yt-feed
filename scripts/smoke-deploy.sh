#!/usr/bin/env bash
#
# Does a fresh deployment come up, and come up *claimable*?
#
# Builds the image, starts it against an empty volume, and checks the handful of
# things that have to be true before a stranger can use this at all. Not a test
# of the app — the suites do that — but of the seam the suites can't reach: an
# image, a volume, and a process that has never run before.
#
#   scripts/smoke-deploy.sh
#
# Leaves nothing behind: its own project name, its own volumes, removed on exit
# however it exits. It never touches your real `data/` or a running dev server.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="ytfeed-smoke-$$"
PORT="${SMOKE_PORT:-8123}"
BASE="http://localhost:${PORT}"
FAILED=0

cd "$ROOT"

cleanup() {
  echo
  echo "--- tearing down ---"
  # -v because these volumes are this script's, not yours. The real deployment's
  # volume is never named here.
  PORT="$PORT" docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1
}
trap cleanup EXIT

check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"
    FAILED=1
  fi
}

contains() { # contains <description> <needle> <haystack>
  case "$3" in
    *"$2"*) printf '  ok    %s\n' "$1" ;;
    *) printf '  FAIL  %s (no %s in: %.120s)\n' "$1" "$2" "$3"; FAILED=1 ;;
  esac
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "--- building ---"
# Not --no-cache: this is run repeatedly while working on the Dockerfile, and a
# cold base-image pull dominates. `docker build --no-cache` when that matters.
if ! PORT="$PORT" docker compose -p "$PROJECT" build; then
  echo "  FAIL  the image did not build"
  exit 1
fi

echo "--- starting on :${PORT} with an empty volume ---"
if ! PORT="$PORT" docker compose -p "$PROJECT" up -d; then
  echo "  FAIL  compose could not start"
  exit 1
fi

printf '  waiting for /api/health '
for _ in $(seq 1 60); do
  [ "$(code "$BASE/api/health")" = "200" ] && break
  printf '.'
  sleep 2
done
echo
if [ "$(code "$BASE/api/health")" != "200" ]; then
  echo "  FAIL  never became healthy. Logs:"
  PORT="$PORT" docker compose -p "$PROJECT" logs --tail=40 app
  exit 1
fi

echo "--- it serves the app ---"
check "/ serves the built SPA" "200" "$(code "$BASE/")"
contains "and it is the SPA, not JSON" "<!DOCTYPE html>" "$(curl -s "$BASE/" | head -c 200)"
check "a client-side route reloads" "200" "$(code "$BASE/watch/abc")"
# The one that keeps tests/test_api_contract.py meaningful: a catch-all that
# answered this would make every frontend call site match whatever it asked for.
check "an unknown /api path is still a 404" "404" "$(code "$BASE/api/no-such-endpoint")"

echo "--- it comes up unclaimed ---"
STATUS="$(curl -s "$BASE/api/setup/status")"
contains "reports itself unclaimed" '"claimed":false' "$STATUS"

LOGS="$(PORT="$PORT" docker compose -p "$PROJECT" logs app 2>&1)"
contains "prints the claim link to the log" "[setup]" "$LOGS"
TOKEN="$(printf '%s' "$LOGS" | sed -n 's/.*token=\([A-Za-z0-9_-]*\).*/\1/p' | head -1)"
if [ -z "$TOKEN" ]; then
  echo "  FAIL  no setup token in the log — the only channel into a fresh deployment"
  FAILED=1
fi

echo "--- and a stranger cannot configure it ---"
check "PUT /api/settings with no token" "403" \
  "$(code -X PUT -H 'Content-Type: application/json' \
       -d '{"values":{"openrouter_api_key":"sk-stolen"}}' "$BASE/api/settings")"
check "PUT /api/settings with a wrong token" "403" \
  "$(code -X PUT -H 'Content-Type: application/json' -H 'X-Setup-Token: nope' \
       -d '{"values":{"openrouter_api_key":"sk-stolen"}}' "$BASE/api/settings")"
check "claiming with a wrong token" "403" \
  "$(code -X POST -H 'Content-Type: application/json' \
       -d '{"token":"nope"}' "$BASE/api/setup/claim")"

if [ -n "$TOKEN" ]; then
  echo "--- the owner claims it ---"
  JAR="$(mktemp)"
  CLAIM="$(curl -s -c "$JAR" -X POST -H 'Content-Type: application/json' \
            -d "{\"token\":\"$TOKEN\"}" "$BASE/api/setup/claim")"
  contains "the claim succeeds" '"claimed":true' "$CLAIM"
  contains "and signs that browser in" '"signed_in":true' \
    "$(curl -s -b "$JAR" "$BASE/api/auth/me")"
  check "a second claim is refused" "409" \
    "$(code -X POST -H 'Content-Type: application/json' \
         -d "{\"token\":\"$TOKEN\"}" "$BASE/api/setup/claim")"

  echo "--- a key goes in and does not come back ---"
  SECRET="sk-or-v1-SMOKE-TEST-SECRET-wxyz"
  check "the owner can store one" "200" \
    "$(code -b "$JAR" -X PUT -H 'Content-Type: application/json' \
         -d "{\"values\":{\"openrouter_api_key\":\"$SECRET\"}}" "$BASE/api/settings")"
  SETTINGS="$(curl -s -b "$JAR" "$BASE/api/settings")"
  case "$SETTINGS" in
    *"$SECRET"*) echo "  FAIL  the key was readable back out of /api/settings"; FAILED=1 ;;
    *) echo "  ok    the key is not readable back out" ;;
  esac
  contains "but is reported as set" '"hint":"…wxyz"' "$SETTINGS"
  rm -f "$JAR"
fi

echo "--- the volume holds what it should ---"
LS="$(PORT="$PORT" docker compose -p "$PROJECT" exec -T app ls /data 2>&1)"
for f in youtube_feed.db config secret_key setup-token downloads; do
  contains "/data/$f" "$f" "$LS"
done

echo
if [ "$FAILED" = "0" ]; then
  echo "PASS — a fresh deployment comes up, serves the app, and is claimable."
else
  echo "FAIL — see above."
  echo "--- last 40 lines of the app log ---"
  PORT="$PORT" docker compose -p "$PROJECT" logs --tail=40 app
fi
exit "$FAILED"
