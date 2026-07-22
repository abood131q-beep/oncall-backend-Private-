# syntax=docker/dockerfile:1

# ═════════════════════════════════════════════════════════════════════════════
# OnCall Backend — Production Image (P7-01)
#
# - Multi-stage: builder compiles native deps (sqlite3); runtime stays minimal
# - node:24-slim = Node LTS line matching the validated runtime (v24.x), glibc
#   (required for sqlite3 prebuilt binaries / node-gyp fallback)
# - Non-root (user `node`, uid 1000)
# - Direct `node server.js` entrypoint: server.js already implements
#   SIGTERM/SIGINT graceful shutdown; npm would swallow signals as PID 1
# - HEALTHCHECK uses Node's built-in fetch — no curl/wget added to the image
#
# Constraints honoured (no code changes):
# - DB must be reachable at /app/oncall.db → backup.js resolves the DB path
#   relative to the app root; moving it via DB_PATH would break admin backups.
#   Solved via symlink /app/oncall.db → /data/oncall.db (see below), which
#   also enables a fully read-only root filesystem (docker-compose.prod.yml).
# ═════════════════════════════════════════════════════════════════════════════

# ─── Stage 1: builder — install production deps (compiles sqlite3 if needed) ──
FROM node:24-slim AS builder

# Build tools only exist in this stage; the runtime image never sees them.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Layer-cache optimization: manifests first — deps re-install only when they change
COPY package.json package-lock.json ./

# Compile sqlite3 from source instead of using its node-pre-gyp PREBUILT binary: the published
# prebuilt links against GLIBC_2.38, newer than node:24-slim (Debian bookworm) provides (2.36), so
# the runtime crashed with "GLIBC_2.38 not found (required by node_sqlite3.node)". Building here
# against THIS image's glibc guarantees the .node binary loads in the identical runtime base. The
# toolchain (python3/make/g++) exists only in this builder stage.
RUN npm ci --omit=dev \
    && npm rebuild sqlite3 --build-from-source \
    && npm cache clean --force

# ─── Stage 2: runtime — minimal production image ──────────────────────────────
FROM node:24-slim AS runtime

# OCI image labels — values injected at build time (see README_DOCKER.md)
ARG VERSION=1.0.0
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="oncall-backend" \
      org.opencontainers.image.description="OnCall ride-sharing & scooter backend — Kuwait" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="https://github.com/abood131q-beep/oncall-backend-Private-" \
      org.opencontainers.image.vendor="OnCall" \
      org.opencontainers.image.licenses="ISC"

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=./oncall.db

WORKDIR /app

# Production node_modules from builder (no compilers, no dev deps)
COPY --from=builder --chown=node:node /build/node_modules ./node_modules

# Application source — only what the server needs at runtime
COPY --chown=node:node package.json server.js database.js ./
COPY --chown=node:node src ./src

# Read-only rootfs support (P7-01 hardening):
# /data holds the real SQLite DB; /app/oncall.db is a symlink into it.
# SQLite (>=3.31) resolves symlinks and creates -wal/-shm beside the REAL file,
# so all DB writes land in the mounted /data volume while /app stays read-only.
# backup.js keeps reading /app/oncall.db through the symlink — no code change.
RUN mkdir -p /app/logs /app/backups /data \
    && ln -s /data/oncall.db /app/oncall.db \
    && chown -R node:node /app/logs /app/backups /data \
    && chown -h node:node /app/oncall.db

USER node

EXPOSE 3000

# Liveness: /health checks DB + memory + event loop; 503 ⇒ unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]

# Direct node process = PID 1 with existing SIGTERM/SIGINT handlers → graceful stop
CMD ["node", "server.js"]
