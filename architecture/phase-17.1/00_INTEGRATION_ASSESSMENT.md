# Phase 17.1 — OnCall Platform Integration: Integration Assessment

**Status:** Analysis & Planning only (no code changed, no code generated, no migration performed)
**Date:** 2026-07-21
**Author:** Principal Engineer, OnCall Mobility Platform
**Scope basis:** ADR-016 … ADR-045 (Enterprise Foundation complete)

---

## 1. Executive Summary

The Enterprise Platform (25 kernels + Runtime + Host + Deployment, ADR-016→045) is
**fully built and self-composing** but is **not yet wired into the live application**.
The production entry point `server.js` boots a standalone Express 5 / Socket.IO 4 / SQLite
process and contains **zero references** to `src/platform`, `src/runtime`, `src/host`, or
`src/deployment` (verified by grep — empty result).

Phase 17.1's objective is therefore precisely defined: run the **existing OnCall backend
unchanged, as a hosted service on top of the Enterprise Platform**, so that the Platform
provides cross-cutting capabilities (config, rate limiting, identity, notifications,
scheduling/jobs, observability, secrets, feature flags, audit) through **adapters**, while
every externally observable behavior — routes, response bodies, DB schema, auth tokens,
Socket.IO semantics — remains **byte-for-byte compatible**.

**Verdict (full detail in `05_READINESS_REPORT.md`): CONDITIONALLY READY.** The architecture
is exceptionally well-suited to this integration because (a) the Platform is strictly
additive — "importing wires nothing until `createPlatform()` is called," and (b) the app
already has a proven, reversible cutover pattern (per-context `*_LEGACY` env flags + an A/B
byte-compatibility harness) that Phase 17.1 can reuse verbatim. Two blockers must be cleared
before any kernel is allowed to *own* persistent behavior. They are identified in §6 and in
the Readiness Report.

---

## 2. What "Integration" Means Here (and What It Does Not)

**In scope:** wrapping the running app so the Platform lifecycle owns process startup,
readiness, health, and graceful shutdown; and progressively routing cross-cutting concerns
through kernel ports **behind adapters that preserve current behavior**.

**Explicitly out of scope (per phase rules):** rewriting the backend, replacing Express or
Socket.IO, changing routes, changing response formats, changing authentication, changing DB
schema. No new Kernel, no new Runtime, no architecture redesign. This phase produces
**analysis and plans only.**

The guiding principle is the one the Platform itself already states in
`src/platform/index.js`: *"Everything is strictly additive."* Integration must inherit that
property — at every step the app must run byte-identically whether the Platform is composed
or not.

---

## 3. Two Worlds, One Repository

The repository currently contains two coexisting architectures that share one SQLite/PG
database:

| | **World A — Live App (legacy + ADR-005 layered)** | **World B — Enterprise Platform (ADR-016→045)** |
|---|---|---|
| Entry | `server.js` (hand-wired) | `src/runtime/bootstrap.js` → `src/platform` |
| HTTP | Express 5.2.1, `src/routes/*` + `src/presentation/api/*Routes` | Gateway kernel (ADR-035), not serving HTTP |
| Realtime | `src/socket.js` (Socket.IO 4.8.3) | Messaging/Mesh kernels (ADR-024/037), unused by app |
| Data | `src/config/database.js` (sqlite3) + `pg` adapter | Storage kernel (ADR-021), memory/file providers only |
| Auth | `src/middleware/auth.js` (JWT + refresh + revocation) | Identity kernel (ADR-027), memory provider only |
| Lifecycle | async IIFE + `process.on(SIGTERM/SIGINT)` | Lifecycle kernel (ADR-040) + Runtime/Host/Deployment |
| Composition | manual DI object (`services`) passed everywhere | `createPlatform()` DI via ports, dependency-ordered |

World B is complete and independently tested (`tests/unit/*` covers every kernel;
`tests/integration/*-ab.mjs` is the A/B harness). World A is what Flutter clients talk to.
**Phase 17.1 is the bridge between them** — and the bridge is a Host-hosted-service wrapper
plus a set of adapters, nothing more.

---

## 4. Integration Inventory (STEP 1 — summary; full tables in `01_MIGRATION_MATRIX.md`)

### 4.1 Routes
- **Legacy routers** (`src/routes/`): `health` (3), `observability` (3), `auth` (8),
  `users` (7), `drivers` (6), `scooters` (12), `taxi` (21), `payment` (6), `admin` (41),
  `notifications` (5). These remain mounted as rollback targets.
- **ADR-005 layered routers** (`src/presentation/api/`): `identity` (8), `users` (7),
  `drivers` (15), `scooters` (11), `fleet` (3), `trips` (15), `commerce` (4), `admin` (28),
  `notifications` (5) — **default-active today**, each with a `*_LEGACY` env flag for
  instant rollback (see `server.js` lines 194–310).
- Terminal `404` handler and a 4-arg global error handler (413/400/500) with Arabic bodies.

### 4.2 Services (`src/services/`)
`analytics`, `backup`, `cache`, `driverMatcher`, `fareCalculator`, `notificationService`,
`otpService`, `payment`, `places`, `smsService`. All are plain factories injected via the
`services` DI object.

### 4.3 Repositories
- **Legacy** (`src/repositories/`): `User`, `Driver`, `Scooter`, `Trip`, `Wallet`,
  `Notification`, `Report` — thin closures over `dbGet/dbAll/dbRun`.
- **Layered** (`src/infrastructure/repositories/`): 15 `*Adapter.js` used by the ADR-005
  contexts (identity, users, drivers, scooters, trips, fleet, admin, commerce, device
  tokens, driver docs/location, read models).

### 4.4 Database
- SQLite (WAL) at `oncall.db` via `src/config/database.js`; `pg` adapter present
  (`src/infrastructure/db/postgresAdapter.js`, `sqlDialect.js`, `migrator.js`) selected by
  `DB_ENGINE`. ~18 tables (users, drivers, taxis, trips, scooters, scooter_rides, wallets,
  transactions, notifications, device_tokens, otp_codes, refresh_tokens, revoked_tokens,
  rate_limit_locks, reports, login_logs, driver_approval_logs, platform_meta).
- Migrations: runtime `src/config/migrate.js` (SQLite, additive) + `migrations/0001_baseline.sql`,
  `migrations/0002_core_schema.pg.sql`.

### 4.5 Middleware (`src/middleware/`)
`auth` (JWT, refresh tokens, persisted revocation store, remote revocation via Redis),
`rateLimiter` (normal/login/phone limits, persisted phone locks), `metrics`, `setup`
(helmet, compression, request-id, CORS, JSON 1 MB, sanitize).

### 4.6 Socket.IO (`src/socket.js`)
JWT `io.use` handshake auth; rooms `driver:<phone>`, `trip:<id>`, `passenger:<phone>`,
`drivers:online`; events `passenger:join`, `driver:join`, `driver:location` (per-socket
120/min rate limit + ownership check + live fare), `driver:register`/`driver:status`
(approval gating), `disconnect` (offline sync); hourly stuck-taxi auto-fix `setInterval`;
optional Redis adapter for multi-replica.

### 4.7 Background & Scheduled Jobs
- `src/services/backup.js` — periodic backup `setInterval` (+ WAL checkpoint).
- `src/services/cache.js` — periodic expiry sweep `setInterval`.
- `server.js` — WAL-checkpoint timer (5 min), startup ghost-trip cleanup (one-shot).
- `src/socket.js` — hourly stuck-taxi auto-fix.
- All use `.unref()` so they never hold the process open.

### 4.8 Configuration
`src/config/env.js` (hand-rolled `.env` parser, single source of truth, fail-fast on missing
`JWT_SECRET`), `src/config/database.js`, `src/config/migrate.js`. `.env.example` documents
the full surface.

### 4.9 Startup Sequence (current, `server.js`)
1. `require('./src/config/env')` (fail-fast) → 2. create `app`, `server`, `io` →
3. `setupMiddleware(app, …)` → 4. build DI `services` (repos, services, io, timers) →
5. `setupSocket(io, services)` → 6. optional dormant AI context → 7. mount routers
(legacy/layered by `*_LEGACY` flags) → 8. `404` + error handler → 9. **async IIFE:**
`runMigrations` → `initRevocationStore` → `initRateLimitStore` → optional Redis wiring →
WAL timer → ghost-trip cleanup → `server.listen` → `startBackupSchedule` → 10.
`SIGTERM/SIGINT` graceful shutdown; `uncaughtException`/`unhandledRejection` guards.

**This ordered sequence is the exact thing the Host/Runtime lifecycle will wrap** — the app
becomes a single hosted service whose `start()` performs steps 2–9 and whose `stop()`
performs step 10.

---

## 5. The Enterprise Platform Target (World B, as built)

`createPlatform()` composes 25 kernels in deterministic dependency order via a data-driven
catalog (`src/platform/platformBuilder.js` → `KERNELS`), injecting each dependency kernel's
**public service** as another kernel's `ports` — no kernel imports another. It exposes
exactly seven methods: `start, shutdown, health, verify, getKernel, listKernels, version`.
`bootstrap()` (ADR-043) wraps create→verify→start→ready into a Runtime; `createHost()`
(ADR-044) manages one Runtime plus isolated hosted services; `createDeployment()` (ADR-045)
adds rollout/rollback/release strategies above the Host.

**Kernel dependency spine (from the catalog):** `event-backbone → config →
{storage, lock, messaging, observability, discovery, ratelimit, resilience, resources,
lifecycle, compatibility}`; `identity ← (config, storage)`; `policy ← (config, identity)`;
`features ← (config, storage)`; `workflow ← (config, messaging, lock, storage)`;
`audit ← (config, storage)`; `scheduler ← (config, lock)`; `secrets ← (config, storage)`;
`notifications ← (config, messaging)`; `jobs ← (config, scheduler)`;
`gateway ← config + ports(identity, policy, ratelimit, features, discovery)`;
`mesh ← config + ports(identity, policy, resilience, ratelimit, discovery)`;
`tenancy ← (config, identity)`; `extensions ← (config, policy)`.

**Critical property (verified):** every kernel currently ships **only** in-memory / file /
env / json providers — there are **no SQLite- or Postgres-backed kernel providers**. Kernels
can therefore be composed and started safely (they hold no app data), but a kernel cannot yet
*own* any persistent legacy store without a new DB-backed provider adapter. This directly
shapes the roadmap and the two readiness blockers.

---

## 6. Core Findings

1. **The app is not on the Platform at all yet.** Integration is greenfield wrapping, not
   re-plumbing — which is lower risk than it sounds because nothing has to be unpicked.
2. **The Platform is strictly additive**, so a "compose-but-don't-consume" first step
   changes zero behavior and is trivially reversible (don't call `createPlatform`).
3. **A reversible cutover pattern already exists and is battle-tested** (`*_LEGACY` flags +
   A/B harness in `tests/integration/*-ab.mjs`). Phase 17.1 reuses it per capability.
4. **Kernels have no persistent providers yet.** Any kernel that would replace a persistent
   legacy store (revocation tokens, rate-limit locks, notifications, jobs) is **blocked**
   until a byte-compatible DB-backed provider adapter exists that reads/writes the *existing*
   tables. Read-through/observe-only kernel usage is not blocked.
5. **Lifecycle ownership is the highest-value, lowest-risk first win.** Wrapping the app as a
   Host hosted service gives dependency-ordered startup, readiness gating, aggregated health,
   and reverse-order graceful shutdown — without touching a single route.

The remaining deliverables detail the component-by-component mapping
(`01_MIGRATION_MATRIX.md`), the dependency graph (`02_DEPENDENCY_GRAPH.md`), the phased
roadmap (`03_INTEGRATION_ROADMAP.md`), the risk and rollback strategy
(`04_RISK_ASSESSMENT.md`), the go/no-go verdict (`05_READINESS_REPORT.md`), and the target
architecture (`06_ARCHITECTURE_DIAGRAM.md`).
