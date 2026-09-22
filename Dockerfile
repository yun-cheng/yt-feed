# One image: the API, the scan scheduler, and the built frontend it serves.
#
# One rather than two because they are one thing at this size — the scheduler
# lives inside the API process (see app/main.py), the SPA is static files, and
# splitting them would buy a second container to keep running and a CORS
# configuration to get wrong. The only companion is Meilisearch, and search
# degrades to empty results without it.
#
# The layout inside mirrors the repository, so `settings.project_root` means the
# same thing here as on a developer's machine and `frontend/dist` is found
# without being told where it is. Everything writable lives at /data.

# --- Build the frontend ------------------------------------------------------
FROM node:22-alpine AS frontend

WORKDIR /build
# Manifests first, so a source-only change doesn't reinstall node_modules.
COPY frontend/package.json frontend/package-lock.json ./
# --legacy-peer-deps because a plain `npm ci` ERESOLVEs in this tree. Not a
# workaround for something rotten: the testing-library and vitest peer ranges
# disagree about React 19, and npm treats that as fatal where it is cosmetic.
RUN npm ci --legacy-peer-deps

COPY frontend/ ./
# `tsc && vite build` — the type check is part of the build on purpose, so an
# image cannot be produced from code that doesn't compile.
RUN npm run build


# --- Run ---------------------------------------------------------------------
FROM python:3.14-slim

# ffmpeg is not optional: the download path muxes audio and video with it, and
# the local-folder feature reads durations and poster frames through ffprobe.
# ca-certificates for TLS to YouTube, Google and OpenRouter.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY --from=frontend /build/dist frontend/dist

# Everything the app writes. A single volume, which is also the answer to "what
# do I back up". Created here (not just declared) so the named volume inherits
# an ownership the app user can actually write to.
ENV DATA_DIR=/data \
    PYTHONUNBUFFERED=1
RUN useradd --create-home --uid 1000 ytfeed \
 && mkdir -p /data \
 && chown -R ytfeed:ytfeed /data /app
USER ytfeed

WORKDIR /app/backend
EXPOSE 8000

# Python rather than curl, which isn't installed and needn't be.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"

# One worker, deliberately. The scan scheduler and the daily resync are in-process
# singletons guarded by a module-level flag (`_refreshing` in app/main.py), and a
# second worker would run a second copy of both against the same SQLite file.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
