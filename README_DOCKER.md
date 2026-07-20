# OnCall Backend — Production Docker (P7-01)

Containerization of the certified P6-06 backend. Zero code changes; Docker artifacts only.

## Build

```bash
docker build -t oncall-backend:1.0.0 .
```

## Run (production)

The image enforces the existing P6-04 production guards at startup. The container will
**exit immediately** unless these are provided:

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | ✅ | `openssl rand -hex 32` |
| `SMS_PROVIDER` | ✅ | `unifonic` or `twilio` (`console` is fatal in production) |
| `SMS_API_KEY` | ✅ | credentials for the chosen provider |
| `REQUIRE_OTP` | ✅ | must be `true` in production |
| `ADMIN_PHONES` | recommended | comma-separated |
| `ALLOWED_ORIGINS`, `SOCKET_CORS_ORIGIN` | recommended | warn-only if unset |
| `GOOGLE_MAPS_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_PROJECT_ID` | optional | features degrade gracefully |
| `PORT` | optional | default `3000` |

Never bake `.env` into the image (`.dockerignore` blocks it). Inject via `--env-file`
or your orchestrator's secret store:

```bash
docker run -d --name oncall \
  --env-file .env.production \
  -p 3000:3000 \
  --read-only --tmpfs /tmp:size=16m \
  --cap-drop ALL --security-opt no-new-privileges:true --init \
  -v oncall-data:/data \
  -v oncall-logs:/app/logs \
  -v oncall-backups:/app/backups \
  --restart unless-stopped \
  --memory 512m --cpus 1 --pids-limit 128 --ulimit nofile=4096:8192 \
  oncall-backend:1.0.0
```

(Prefer `docker compose -f docker-compose.prod.yml up -d` — same settings, versioned.)

## Recommended: full-stack deployment (P7-02 compose)

```bash
./deploy.sh   # bootstrap (secrets + .env.production) → validate → up → verify
```

`deploy.sh` auto-generates infra secrets and a `.env.production` with a fresh
`JWT_SECRET`; only real SMS credentials must be filled in (the app's P6-04 guard
refuses to start without them — by design). Or run the compose file directly after
that one-time bootstrap: `docker compose -f docker-compose.prod.yml up -d`.

The stack runs 4 services: **oncall-backend**, **postgresql**, **redis**, **nginx**
(P7-03 production edge gateway: TLS 1.3/1.2 + HTTP/2, HTTP→HTTPS redirect, HSTS +
security headers, edge rate limiting on auth/OTP endpoints, Socket.IO WebSocket
pass-through — never throttled, gzip, Slowloris/flood protections). Topology:

- `edge` network — nginx only; **ports 80 (redirect/ACME) and 443 (TLS) are the
  stack's only public ports**

**Certificates** (`certs/fullchain.pem` + `certs/privkey.pem`, volume-mounted
read-only; git-ignored): `deploy.sh` generates a self-signed pair for development.
For production, place Let's Encrypt or wildcard certs at the same paths — the
HTTP-01 webroot (`/.well-known/acme-challenge/` → `acme-webroot` volume) is already
wired for a future certbot container; reload with
`docker compose -f docker-compose.prod.yml exec nginx nginx -s reload`.

**Rate-limit design:** per-IP zones — auth 30 r/m (login/refresh), OTP 10 r/m,
general API 30 r/s with burst 60 (deliberately generous: carrier NAT + driver
location updates). `/socket.io/` is exempt so active rides are never throttled.
The backend's per-phone limiter remains the precise second layer.
- `internal` network (`internal: true`) — backend ↔ postgres ↔ redis; unreachable
  from the host; postgres/redis expose no ports anywhere
- Startup order: postgres healthy + redis healthy → backend → nginx
- Every service: read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, non-root
  user, tmpfs, mem/cpu/pids/nofile limits, json-file logging (10 MB × 5 rotation)

⚠️ **Current-state note:** the backend still runs on SQLite + in-memory stores;
postgres/redis are forward-provisioned for the ADR-001 migration and are not yet
consumed by application code. The API is fully reachable through nginx on port 80
(`curl http://localhost/health`).

## Persistence layout

| Container path | Purpose | Mount |
|---|---|---|
| `/data` | SQLite DB + `-wal`/`-shm` | named volume `oncall-data` |
| `/app/backups` | scheduled + on-demand DB backups | named volume |
| `/app/logs` | app / error / security logs | named volume |
| `/tmp` | scratch | tmpfs |

**How the read-only rootfs works with SQLite:** the image bakes a symlink
`/app/oncall.db → /data/oncall.db`. SQLite (≥3.31) resolves symlinks and creates the
`-wal`/`-shm` files next to the **real** file in `/data`, so all writes land in the
volume while `/app` stays immutable. `backup.js` keeps reading `/app/oncall.db`
through the symlink — zero code changes.

⚠️ Do **not** relocate the DB with `DB_PATH`: `backup.js` resolves the DB at the app
root, so a relocated DB would silently break the admin backup feature. Aligning
`backup.js` with `DB_PATH` is queued as a P7-02 backlog item.

## Observability (P7-04)

`docker-compose.monitoring.yml` (deployed automatically by `deploy.sh`) adds:
Prometheus (15d retention), Grafana (auth required, provisioned dashboards),
node-exporter, postgres-exporter, redis-exporter, nginx-exporter (scrapes the
internal-only `:8081/stub_status`), blackbox-exporter (backend `/health` + TLS
cert expiry), cAdvisor. All exporters are internal-network only; the only host
bindings are `127.0.0.1:9090` (Prometheus) and `127.0.0.1:3001` (Grafana) —
reach them via SSH tunnel: `ssh -L 3001:127.0.0.1:3001 <host>`.

Dashboards (folder "OnCall"): Platform Health, System, Backend (edge view),
PostgreSQL, Redis, Nginx Edge. Alerts (8): BackendDown, HighCPU, HighMemory,
DiskNearlyFull, DatabaseUnavailable, RedisUnavailable, CertificateExpirySoon,
HighHttp5xx.

Centralized logging is prepared but not required:
`docker compose ... --profile logging up -d` starts Loki + Promtail (ships all
`oncall-*` container logs; Grafana Loki datasource pre-provisioned).

Note: backend business metrics (active drivers/rides, per-route req/s) await
backlog **M-5** (native `/metrics` endpoint — an app change requiring approval).

## Backup & Disaster Recovery (P7-05)

`docker-compose.backup.yml` (deployed automatically by `deploy.sh`) runs the
`oncall-backup` agent (internal network only): **SQLite every 15 min (RPO ≤ 15 min
for the live production data)** + daily/weekly/monthly full sets (SQLite +
pg_dump -Fc + Redis RDB + configs). Retention 96/7/4/12 with automatic pruning.
Every bundle: component-verified → sha256 manifest → **gpg AES256 encrypted**
(safe for untrusted off-site storage). Secret *values* are never backed up —
only names + checksums. Weekly automatic `restore-test.sh` proves restorability;
the agent's healthcheck goes unhealthy if backups stop.

Runbook: `docs/DISASTER_RECOVERY_RUNBOOK.md` (server loss, DB/Redis corruption,
cert replacement, failed deploys, off-site replication — **required** for true
disaster survival — RPO ≤ 15 min / RTO ≤ 60 min).
Store `secrets/backup_encryption_key.txt` OFF the server: no key, no restore.

## Supply chain: scan, SBOM, signing, multi-platform

`.github/workflows/docker-release.yml` runs on version tags:
build (amd64) → **Trivy scan gating on 0 Critical / 0 High** → SBOM (syft, CycloneDX)
→ multi-platform push (linux/amd64 + linux/arm64 via buildx/QEMU) → **cosign keyless
signing** (OIDC — no key management needed).

Already generated locally (dependency level): `docs/SBOM-oncall-backend-1.0.0.cdx.json`
(CycloneDX 1.6, 137 production components); `npm audit --omit=dev` = 0 vulnerabilities
(all severities). The base-image OS layer is scanned by the Trivy step in CI.

Manual equivalents on any Docker host:

```bash
# Multi-platform build
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg VERSION=1.0.0 --build-arg REVISION=$(git rev-parse HEAD) \
  --build-arg CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t oncall-backend:1.0.0 .

# Scan (must report 0 CRITICAL / 0 HIGH)
trivy image --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 oncall-backend:1.0.0

# SBOM
syft oncall-backend:1.0.0 -o cyclonedx-json > sbom.cdx.json

# Sign (keyless)
cosign sign --yes <registry>/oncall-backend:1.0.0
```

## Design decisions

- **Multi-stage build** — build tools (python3/make/g++ for the `sqlite3` native addon)
  exist only in the builder stage. Runtime is `node:22-slim` (Node LTS line matching the
  validated v22.x runtime; glibc for the sqlite3 binary).
- **`CMD ["node","server.js"]`** instead of `npm start` — `server.js` already implements
  graceful shutdown (SIGTERM/SIGINT → close Socket.IO → close HTTP → exit, 10 s force
  timeout). Running node directly as PID 1 delivers signals to those handlers; `npm`
  as PID 1 does not forward them reliably.
- **Non-root** — runs as the stock `node` user (uid 1000). `/app` is node-owned because
  SQLite must create `-wal`/`-shm` files beside the DB in the app root (see constraint
  above). Mitigations: immutable image, no compilers, no curl/wget added, `.env` never
  present in the image.
- **Healthcheck** — Node built-in `fetch` against `/health` (DB + memory + event-loop
  checks already implemented); no extra binaries installed.
- **Layer caching** — lockfile-only layer before source copy: dependency layers rebuild
  only when `package-lock.json` changes.
- **Redis** — not used by this backend (in-memory cache/rate-limit stores with SQLite
  persistence); nothing to preserve. The rateLimiter's documented Redis upgrade path is
  unaffected.

## Verify a running container

```bash
docker inspect --format '{{.State.Health.Status}}' oncall   # → healthy
curl -s localhost:3000/health                               # → {"status":"ok",...}
docker stop oncall                                          # graceful: "SIGTERM received — shutting down gracefully"
```
