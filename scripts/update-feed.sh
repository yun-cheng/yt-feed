#!/bin/bash
# Daily YouTube video fetcher — run via cron
cd "$(dirname "$0")/../backend" || exit 1
source .venv/bin/activate
exec python -m app.cron_update