# Phase 17.1 — Migration Matrix (STEP 2)

Component-by-component mapping of the current OnCall backend onto the Enterprise Platform.
For every component: **current implementation → target kernel → difficulty → risk →
compatibility considerations → required adapters → required wrappers.**

Legend — **Difficulty:** Trivial / Low / Medium / High. **Risk:** Low / Medium / High.
"Own" = kernel becomes source of truth. "Observe" = kernel consumes/mirrors, legacy stays
source of truth. **Default posture for Phase 17.1 is Observe/wrap, never Own**, except where
a byte-compatible DB provider is delivered first.

---

## A. Process / Composition / Lifecycle

| Component | Current implementation | Target kernel / layer | Difficulty | Risk | Compatibility considerations | Required adapters | Required wrappers |
|---|---|---|---|---|---|---|---|
| Process bootstrap | async IIFE in `server.js` | **Host (ADR-044) + Runtime (ADR-043)** | Medium | Medium | Listen order, migrations-before-listen, exit codes must be preserved | — | **`OnCallAppService`** hosted-service wrapper: `start()` runs current steps 2–9, `stop()` runs shutdown; registered via `host.register()` |
| Startup ordering | implicit statement order | **Lifecycle (ADR-040)** dependency graph | Medium | Medium | Migrations MUST complete before `server.listen`; revocation/rate stores load before traffic | — | Declare hosted-service `dependsOn` so app starts after platform kernels are READY |
| Readiness / liveness | `/health`, `/health/live`, `/health/ready` in `observability` route | **Observability (ADR-033)** + Runtime `ready()`/`health()` | Low | Low | Existing endpoints must return identical bodies/status codes | Health adapter mapping Runtime health → existing JSON shape | Keep existing routes; optionally *feed* them from Runtime health |
| Graceful shutdown | `io.close`→`server.close`, 10 s force timer | **Runtime `shutdownManager` + Lifecycle reverse-order stop** | Medium | Medium | Socket.IO must close before HTTP; 10 s cap; same exit codes | — | Shutdown hook on the hosted service delegating to current logic |
| Crash guards | `uncaughtException`/`unhandledRejection` | Runtime supervisor / Observability | Low | Low | Must still `process.exit(1)` on fatal | — | Keep process-level guards; optionally report to Observability |

---

## B. HTTP Layer

| Component | Current implementation | Target kernel / layer | Difficulty | Risk | Compatibility considerations | Required adapters | Required wrappers |
|---|---|---|---|---|---|---|---|
| Express app + routers | Express 5.2.1; legacy `src/routes/*` + layered `src/presentation/api/*Routes` | **Runs as-is inside the hosted service.** Gateway kernel (ADR-035) NOT placed in request path in 17.1 | Low (wrap) / High (if fronted) | Low / High | Routes, params, order, first-match semantics, Arabic bodies, 404/error shapes must not change | — | Hosted service owns the `app`; Platform provides deps via a **context adapter**, not by fronting Express |
| API Gateway (routing/authz/ratelimit at edge) | none in request path | **Gateway (ADR-035)** — *observe-only* | High | High | Any edge interception can alter status/headers/latency; **defer past 17.1** | Gateway route-mirror adapter (shadow) | Shadow-compare only; never in the live path in 17.1 |
| Global error handler | 4-arg handler (413/400/500) | keep as-is; Observability may record | Trivial | Low | Exact Arabic messages + status codes | Error→metric adapter (optional) | none |

**Ruling:** In Phase 17.1 the Gateway kernel is **not** inserted in front of Express. The
phase rules forbid changing routes/response formats; edge routing is the highest-risk way to
violate that. Gateway stays observe-only (shadow) and is a candidate for a later phase.

---

## C. Realtime (Socket.IO)

| Component | Current implementation | Target kernel / layer | Difficulty | Risk | Compatibility considerations | Required adapters | Required wrappers |
|---|---|---|---|---|---|---|---|
| Socket.IO server + handlers | `src/socket.js` (JWT `io.use`, rooms, events) | **Runs as-is inside hosted service.** Mesh (ADR-037) / Messaging (ADR-024) NOT in path | Low (wrap) | Low | Handshake auth, room names, event names/payloads, 120/min limit, live-fare math must not change | — | `io` created and owned by the hosted service exactly as today |
| Socket auth | `verifyJWT` in `io.use` | **Identity (ADR-027)** — *observe-only* | Medium | High | Token format/claims identical; Identity has memory provider only | Identity read-through adapter | Do not replace `verifyJWT` in 17.1 |
| Cross-replica fan-out | optional Redis adapter | **Mesh/Messaging** — defer | Medium | Medium | Redis adapter behavior must be preserved when `REDIS_URL` set | — | Keep existing Redis path |
| Socket rate limiting | per-socket `checkRateLimit` | **Ratelimit (ADR-031)** — observe | Medium | Medium | Exact 120/min window semantics | Ratelimit adapter (shared with HTTP) | none in 17.1 |

---

## D. Data / Persistence

| Component | Current implementation | Target kernel / layer | Difficulty | Risk | Compatibility considerations | Required adapters | Required wrappers |
|---|---|---|---|---|---|---|---|
| DB connection + helpers | `src/config/database.js` (`dbGet/dbAll/dbRun/dbTransaction`), WAL PRAGMAs | **Storage (ADR-021)** — *provider wrap*, app keeps helpers | High | High | Schema, PRAGMAs, WAL, SQLITE_BUSY retry, FK enforcement must be byte-identical | **SQLite/PG-backed Storage provider** wrapping existing helpers | App continues to call `dbGet/dbAll/dbRun`; Storage provider is added *around* them, not instead of |
| Postgres dialect | `postgresAdapter.js`, `sqlDialect.js`, `migrator.js` (`DB_ENGINE`) | Storage provider (PG) | Medium | Medium | Dual-dialect parity already exists; preserve | reuse existing adapters | none |
| Migrations | `src/config/migrate.js` (runtime, additive) + `migrations/*.sql` | **Lifecycle-ordered** startup step | Low | Medium | Must run before listen; must stay additive; no schema change in 17.1 | — | Migration invoked as a hosted-service pre-start hook |
| Repositories (legacy 7 + layered 15 adapters) | closures over db helpers | stay in app; Storage underneath | Low | Low | Query results identical | — | none |

**Blocker:** no DB-backed Storage provider exists (all kernels memory/file only). Storage
"Own" is gated on delivering a provider that reads/writes the **existing** tables with
identical semantics — see Readiness Report blocker **B1**.

---

## E. Authentication & Authorization

| Component | Current implementation | Target kernel / layer | Difficulty | Risk | Compatibility considerations | Required adapters | Required wrappers |
|---|---|---|---|---|---|---|---|
| JWT issue/verify | `src/middleware/auth.js` `generateJWT/verifyJWT` | **Identity (ADR-027)** | High | High | Token structure, claims, `exp`, secret handling identical; Flutter holds live tokens | Identity provider backed by existing JWT logic | Keep middleware; Identity observes first |
| Refresh tokens | `refresh_tokens` table + rotate/revoke | Identity (session mgmt) | High | High | Rotation + reuse-detection semantics identical | DB-backed Identity/session provider over `refresh_tokens` | none in 17.1 |
| Token revocation | `revoked_tokens` table + Redis pub/sub | Identity + Messaging | High | High | Cross-replica propagation timing identical | DB+Redis revocation provider | Keep `initRevocationStore`/`applyRemoteRevocation` |
| Role guards | `authenticate*`, `ADMIN_PHONES` | **Policy (ADR-025)** — observe | Medium | Medium | Admin allow-list, per-role gates identical | Policy adapter reading `ADMIN_PHONES` | none in 17.1 |

**Ruling:** Auth is the single most compatibility-sensitive surface (live Flutter tokens).
17.1 does **not** change authentication. Identity/Policy are **observe-only** until a
provider proves byte-identical token/claim behavior under the A/B harness. Readiness blocker
**B2**.

---

## F. Configuration & Secrets

| Component | Current implementation | Target kernel / layer | Difficulty | Risk | Compatibility considerations | Required adapters | Required wrappers |
|---|---|---|---|---|---|---|---|
| Env/config | `src/config/env.js` (single source of truth, fail-fast) | **Config (ADR-019)** (`envProvider` exists) | Low | Low | Same values, same fail-fast on `JWT_SECRET`; normalization (LOG_LEVEL) preserved | Config `envProvider` seeded from `env.js` output | `env.js` stays authoritative; Config mirrors it read-only |
| Secrets (JWT secret, Firebase, SMS keys) | env-loaded strings | **Secrets (ADR-028)** — observe | Medium | Medium | No behavior change; redaction must not leak | Secrets provider over env | none in 17.1 |

Config is the **safest first consumer** — it already has an `envProvider`, and read-only
mirroring changes nothing.

---

## G. Cross-Cutting Services

| Component | Current implementation | Target kernel / layer | Difficulty | Risk | Compatibility considerations | Required adapters | Required wrappers |
|---|---|---|---|---|---|---|---|
| Rate limiting (HTTP) | `src/middleware/rateLimiter.js` + `rate_limit_locks` table | **Ratelimit (ADR-031)** | Medium | Medium | Exact window/limit/lock semantics; persisted phone locks | DB-backed ratelimit provider over `rate_limit_locks` | Keep middleware; kernel observes then (later) owns |
| Notifications / push | `notificationService.js`, `smsService.js`, `otpService.js`, `device_tokens`, `notifications` | **Notifications (ADR-030)** | Medium-High | Medium | Delivery order, retry, dedupe, payloads identical; OTP timing | DB-backed notifications provider + push/SMS gateway adapters (adapters already exist in `infrastructure/`) | Keep services; kernel observes |
| Background jobs | `backup`, `cache` sweep `setInterval` | **Jobs (ADR-032)** | Low | Low | Same cadence, `.unref()` semantics | Job handlers wrapping existing functions | Register as Jobs handlers (opt-in) |
| Scheduled work | WAL timer, hourly taxi auto-fix, ghost cleanup | **Scheduler (ADR-020)** | Low | Low | Same intervals; idempotent | Schedule entries wrapping existing timers | Register as Scheduler jobs (opt-in) |
| Metrics | `src/middleware/metrics.js`, `/metrics` | **Observability (ADR-033)** | Low | Low | `/metrics` output format identical | Metrics bridge | Keep endpoint; feed Observability |
| Feature flags | `*_LEGACY` env flags | **Features (ADR-029)** | Low | Low | Flag semantics identical | Features provider reading env flags | Optional; env flags remain authoritative |
| Audit | `login_logs`, `driver_approval_logs`, admin audit | **Audit (ADR-026)** — observe | Medium | Low | No change to written rows | Audit provider over existing tables | none in 17.1 |
| Caching | `src/services/cache.js` (in-proc TTL) | **Storage/Resources** (optional) | Low | Low | Same TTLs | — | none |

---

## H. Kernels With No 17.1 App Mapping (compose, do not consume)

`workflow` (ADR-023), `discovery` (ADR-034), `resilience` (ADR-036), `mesh` (ADR-037),
`tenancy` (ADR-038 — OnCall is single-tenant today), `resources` (ADR-039),
`compatibility` (ADR-041 — used by `platform.verify()`), `extensions` (ADR-017).
These are composed for completeness/health but have **no consuming adapter** in 17.1. Listing
them keeps the mapping exhaustive and prevents accidental premature coupling.

---

## I. Migration Posture Summary

| Posture | Components | When allowed |
|---|---|---|
| **Wrap now (safe, additive)** | Lifecycle/Host wrapping, Config mirror, Observability feed, Jobs/Scheduler opt-in registration | Phase 17.1 immediately |
| **Observe-only (shadow, no path change)** | Identity, Policy, Ratelimit, Notifications, Audit, Secrets, Gateway, Mesh | Phase 17.1, non-blocking |
| **Own (blocked until DB provider + A/B proof)** | Storage, then Ratelimit, Notifications, Identity/refresh/revocation | Later phases, gated on B1/B2 |
| **Do not touch** | Express routing, response bodies, Socket.IO semantics, auth tokens, DB schema | Never in 17.1 |
