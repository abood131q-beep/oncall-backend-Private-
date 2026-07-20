# OnCall Platform — Independent Production-Readiness Audit

**Auditor:** Independent Principal Engineering Audit Team (adversarial, no stake in prior work)
**Date:** 2026-07-20 · **Method:** direct repository inspection; every claim cited to code. Prior migration reports were NOT trusted.
**Verdict headline:** Excellent *architecture and code craft* on a **fundamentally single-node runtime**. Ready for a single-region launch (hundreds–low thousands of users). **Not** ready for horizontal scale or high availability without externalizing state (Postgres + Redis) — both are provisioned in compose but **not consumed by any code**.

---

## 1. Executive Summary

The migration is real, not cosmetic: 116 enterprise files across 11 bounded contexts pass a
CI-gated architecture verifier with **0 violations**; 180 unit tests pass; `npm audit` reports **0
vulnerabilities**; the hand-rolled JWT is actually implemented correctly. This is top-decile *code*.

But production readiness is a **runtime** property, and here the platform hits a wall it cannot climb
by adding hardware:

- **One SQLite file, one shared connection, one in-process write mutex** (`src/config/database.js:114 _txChain`, `database.js:7 new sqlite3.Database`). All writes across the entire platform serialize through a single Node process. **Two instances cannot coexist** — the mutex is per-process; a second process collides at SQLite.
- **All cross-request state is in-memory**: token revocation (`src/middleware/auth.js:27 REVOKED_TOKENS = new Map()`), rate limiting (`src/middleware/rateLimiter.js:20`), request metrics, and the **Socket.IO adapter** (no Redis adapter — `grep` confirms none). Every one of these is lost on restart and invalid across replicas.
- **Postgres and Redis are provisioned in `docker-compose.prod.yml` but consumed by zero lines of application code** (`grep -r "require('redis'|'pg'|'ioredis')" src` → NONE). Their presence in compose creates a false readiness signal.

Net: **strong single-node system, weak distributed system.** The scores below reflect that split.

**Production Readiness: ~62%.** **Overall Engineering (craft): 7.5/10.** **Scale/HA readiness: 3/10.**

---

## 2. Architecture Audit — **9/10**

**Verified strengths (from code):**
- Clean layering enforced mechanically. `architecture/compliance/verify-architecture.mjs` runs R1–R7 and is **gated in CI** (`ci.yml:245–288`: build fails on CRITICAL/MAJOR). I re-ran it: **PASS, 0 violations, 116 files**.
- Genuine Ports & Adapters + DDD: pure `src/domain/*` (no framework/SQL/SDK), `src/application/*` orchestration with `assertPorts` fail-fast, infra isolation, thin presentation. Verified by inspection across contexts.
- Dependency rule holds: presentation imports no domain/infra (the one violation I found while auditing was already the kind the verifier catches — it is green now).
- Strangler pattern is honestly applied: every context has a `*_LEGACY` rollback switch in `server.js`.

**Deductions:**
- **9 legacy route files remain in `src/routes/` (admin, taxi, users, scooters, notifications, payment, drivers…)** — shadowed dead code when the new routers are active (kept as rollback, but 8/9 are dormant weight). No retirement date enforced.
- Two empty top-level dirs (`admin/`, `infra/`) — structural noise.
- The AI context is *dormant* (composed, mounts nothing) and Commerce settlement is *reused-in-place* rather than routed through its own use case — defensible, but leaves two "owned but not wired" seams.

CQRS: not formally present (commands/queries share repos) — acceptable at this scale, not a defect.

---

## 3. Security Audit — **6.5/10**

**Verified strengths:**
- **JWT is hand-rolled but correct** (`src/middleware/auth.js:173`): server recomputes HMAC-SHA256 and ignores the token's `alg` header ⇒ **no `alg:none` forgery**; `exp` enforced; `crypto.timingSafeEqual` ⇒ no signature timing oracle. Tokens accepted only from headers, never query string.
- Refresh tokens and OTP codes stored as **SHA-256 hashes**, never plaintext (`auth.js:99`, `otpService.js`), with an `attempts` column.
- `helmet` applied (`setup.js:44`), body size capped at **1MB** (`setup.js:76`), manual `X-Content-Type-Options: nosniff` etc.
- **IDOR defended in code**: wallet reads use JWT phone, not `req.params.phone` (`commercePolicies.js ownershipPolicy`, mirrored across users/notifications). Verified in A/B (`balance:idor → 403`).
- **SQL injection**: all queries are parameterized (`?` placeholders) — spot-checked WalletRepository, admin adapter, all repos. No string concatenation into SQL found.
- Path traversal on DB restore is guarded (`adminPolicies.js restorePolicy`: `basename` + `^[\w\-. ]+\.db$` + no leading dot). `npm audit`: **0 vulnerabilities**. `.env`, `*.db`, `secrets/` are gitignored and **not tracked**.

**Vulnerabilities / risks (proven):**
- **[HIGH] Token revocation is in-memory (`REVOKED_TOKENS = new Map()`).** *Attack:* admin suspends a malicious driver → on the next deploy/restart (or on any other replica) the Map is empty, so the driver's **still-unexpired JWT is honored again**. Revocation must be a shared store (Redis/DB) with `iat`/jti checks. Refresh-token revocation *is* in the DB (good), but access-token revocation is not.
- **[HIGH] Rate limiting is in-memory & per-process (`rateLimiter.js:20`).** Behind a load balancer or after a restart, OTP/login attempt counters reset ⇒ **brute-force throttling is bypassable**. 6-digit OTP + resettable counter is a real account-takeover vector at scale.
- **[MED] Socket.IO CORS defaults to `*`** (`env.js:190 SOCKET_CORS_ORIGIN: … || '*'`) with only a console warning. If unset in prod, any origin can open a socket.
- **[MED] No schema-validation library** (no joi/zod/ajv — confirmed). Validation is hand-written per handler; easy to miss a field/type on future endpoints.
- **[LOW] Hand-rolled JWT** is correct today but a standing liability — one refactor away from a subtle bug a vetted library would prevent.
- CSRF: low risk (token-in-header API, not cookie-auth). XXE/SSRF: no XML parsing; outbound calls limited to SMS/push/places providers — acceptable.

---

## 4. Performance Audit — **6/10**

- **Global write serialization** (`_txChain` mutex) is the dominant hotspot: every `dbTransaction` (trip completion + payment, driver approval, etc.) runs one-at-a-time process-wide. Fine at low concurrency; a throughput cliff under load.
- **WAL is not being checkpointed**: `oncall.db` = 827 KB but `oncall.db-wal` = **4.1 MB** and growing. Unbounded WAL → slower reads, longer recovery, disk pressure. No periodic `wal_checkpoint(TRUNCATE)` on a timer (only on restore).
- Positives: response-time cache with TTLs (`cache.js`), atomic single-statement deduct (`deductBalanceSafe`, no read-modify-write race), async `exec` for system info, `compression` enabled.
- N+1: the admin dashboard fires 16 `dbGet` in one `Promise.all` — bounded and acceptable; no unbounded per-row query loops found.
- Metrics collection is in-memory arrays (`getMetrics`) — memory grows with sampled requests unless capped (check bounding).

---

## 5. Scalability Audit — **3/10** (the critical gap)

| Target | Verdict | Reason (from code) |
|---|---|---|
| 100 users | ✅ Comfortable | single instance, SQLite trivially handles it |
| 1,000 users | ✅ Fine | WAL + cache; write volume low |
| 10,000 users | ⚠️ Marginal | one city, moderate concurrency; the write mutex + single SQLite writer start to bound peak dispatch/settlement throughput; still **one instance only** |
| 100,000 users | ❌ No | single process cannot be replicated; in-memory rate-limit/revocation/sockets break the moment you add a 2nd node |
| 1,000,000 | ❌ No | SQLite single-writer + single-node architecture |
| 10,000,000 | ❌ No | fundamentally not a distributed system today |

**Why it cannot scale horizontally (each independently fatal):**
1. In-process transaction mutex ⇒ correctness depends on there being exactly one process.
2. Socket.IO has **no Redis adapter** ⇒ a passenger connected to node A can't receive an event emitted on node B.
3. Rate limiter + token revocation + metrics are per-process Maps ⇒ inconsistent across replicas.
4. SQLite is a single-writer embedded file ⇒ no shared multi-node database.

**The remediation is known and already named in ADR-001 Option E / ADR-004:** migrate to Postgres, add `@socket.io/redis-adapter`, move rate-limit + revocation to Redis. The seams exist (repositories, gateways) — this is the single highest-leverage work item.

---

## 6. Database Audit — **5/10**

- Engine: **SQLite**, one shared connection (`database.js:7`), WAL + `foreign_keys=ON` + `synchronous=NORMAL`. Good pragmas for single-node.
- **No migration framework**: schema is created imperatively in `database.js` (`db.serialize`) + `src/config/migrate.js`. There is **no versioned migrations directory** — schema evolution is ad-hoc and not reproducibly ordered across environments. This is a production risk (no rollback of schema, no history).
- `wallets` table exists but unused (balance lives in `users.balance`) — latent confusion.
- WAL growth (§4). Backups exist (`backups/`, `backup/`, `docker-compose.backup.yml`) — restore path is code-guarded.
- No read replicas, no connection pool (impossible with SQLite).

---

## 7. API Audit — **7.5/10**

- Consistent envelope (`{ success, … }`), frozen contracts proven byte-identical by 11 A/B harnesses (230 scenarios). Arabic default + additive English (ADR-003) verified.
- Auth middleware consistent (`authenticate`/`authenticateDriver`/`authenticatePassenger`/`authenticateAdmin`). 404/error handlers centralized.
- **Gaps:** no API versioning (`/v1`), no OpenAPI/Swagger spec, no pagination on some list endpoints (e.g. `/admin/users` returns all), no request-id propagation to clients beyond a header. No API gateway.

---

## 8. Flutter Audit — **N/A (not in this repo)**

No Flutter/Dart sources are present in this backend repository (confirmed: no `pubspec.yaml`, no `lib/`). The mobile client is out of scope here; the backend only *references* Flutter in comments. **Cannot audit what isn't here** — flag: the API is the contract, and its lack of versioning/OpenAPI raises client-coupling risk.

---

## 9. Infrastructure Audit — **6.5/10**

- Dockerfile: **multi-stage**, `node:22-slim`, `npm ci --omit=dev`, **non-root `USER node`**, `HEALTHCHECK` via built-in fetch, `NODE_ENV=production` — all correct.
- `docker-compose.prod.yml` provisions **postgres + redis + nginx (TLS) + monitoring**, but the app consumes **none** of postgres/redis (proven). So the compose is aspirational infra around a SQLite single-node app.
- nginx TLS edge, `secrets/` via files, `.dockerignore` present.
- **No Kubernetes manifests** anywhere (no `k8s/`, no Helm chart) — despite "K8s readiness" being a goal.

---

## 10. CI/CD Audit — **7.5/10**

- 6 workflows: `ci.yml` (security/lint/test/mcp-test/architecture/build), `quality.yml`, `deploy.yml`, `docker-release.yml`, `release-please.yml`, `emergency-rollback.yml`.
- **Verifier IS CI-gated** (`ci.yml:245`, fails on CRITICAL/MAJOR). `npm audit --audit-level=high` gates. Lint + format gate.
- **[HIGH gap] The A/B compatibility harnesses (`tests/integration/*-ab.mjs`) are NOT run in CI or `run_tests.sh`** (grep across workflows + run_tests.sh → no reference). The entire "byte-identical" guarantee — the backbone of the migration — is **manually run and not continuously enforced**. A future change can silently break a public contract and CI stays green.
- No code-coverage measurement/threshold. No load test, DAST, or container scan in CI.

---

## 11. Cloud Readiness — **3/10**

Not 12-factor for state: process is stateful (in-memory revocation/limits/metrics/sockets) and storage is a local file. Cannot run >1 replica. No externalized session/cache. Secrets via files (workable). **Verdict: containerized, not cloud-native.**

## 12. Kubernetes Readiness — **2/10**

No manifests/Helm. Even if authored, the app can't run as a multi-replica Deployment (state + SQLite). Would need: StatefulSet-with-1-replica hack (defeats the purpose) OR the Postgres/Redis externalization first. Liveness/readiness probes are feasible (`/health` exists) but that's the only piece present.

## 13. Docker Audit — **8/10**

Genuinely good (see §9): non-root, multi-stage, slim, healthcheck, prod env. Minor: SQLite data must be on a mounted volume (single-node) — document the volume + backup policy explicitly; ensure `oncall.db-wal` is checkpointed before image/volume snapshots.

## 14. Monitoring Audit — **6/10**

- `/health` (db/memory/event-loop), structured `logger` (logs/security/errors/crashes), in-process request metrics, and a full **Prometheus + Grafana + Loki + Promtail + Blackbox** compose stack.
- **Gaps:** metrics are in-memory (lost on restart, per-process, not scrapeable) — there is **no `/metrics` `prom-client` exposition endpoint** (the M-5 gap named in ADR-010). Grafana/Prometheus are provisioned with nothing real to scrape from the app. No distributed tracing (OpenTelemetry). No alerting rules wired to a pager.

---

## 15. Technical Debt (ranked)

1. **State externalization (Redis) + DB (Postgres)** — unblocks scaling, HA, correct rate-limit/revocation. *Largest single item.*
2. **A/B harnesses into CI** — protect the compatibility guarantee.
3. **Versioned migration framework** — reproducible schema.
4. **Retire 9 shadowed legacy route files** after a soak; delete empty `admin/`, `infra/`.
5. **WAL checkpoint timer**; bound in-memory metrics arrays.
6. **`/metrics` prom-client endpoint** + alert rules.
7. Replace hand-rolled JWT with a vetted lib (or add a fuzz/negative test suite around it).

## 16. Code Smells

- Duplicated logic between legacy routers and new controllers (intentional rollback duplication, but now permanent-looking).
- `PAYMENT_METHODS` catalog duplicated in `commerceGateways.js` and legacy `payment.js`.
- Mixed-language identifiers/comments (Arabic + English) — fine for the team, raises onboarding cost for outside FAANG reviewers.
- Global mutable module state (Maps) in middleware.

## 17. Dead Code

- 8 of 9 `src/routes/*.js` are shadowed when new routers are active (dead on the hot path).
- `wallets` table (unused). Empty `admin/`, `infra/` dirs. Root-level one-off files: `integration-test.mjs`, `integration-test-results.txt`, `P6-06_RELEASE_VALIDATION_*.md`, `oncall-test.command` — stale artifacts in repo root.

## 18. Dependency Risks — **8.5/10**

Only 6 runtime deps (express, socket.io, sqlite3, helmet, cors, compression) — small surface, `npm audit` clean. Risk: **`sqlite3` native addon** ties you to a single-node embedded DB (the scaling ceiling) and to native-build friction (the repo even ships a `tools/dev/sqlite3-compat.js` shim to run tests without the native module — a smell that the native dep is fragile).

## 19. Missing Enterprise Features

Versioned migrations; externalized cache/session (Redis); Postgres; API versioning + OpenAPI; distributed tracing; centralized secret manager (Vault/KMS); feature-flag service; audit-log store separate from app logger; multi-tenant/region partitioning (ADR-004 is designed for it, code isn't there yet).

## 20. Missing Production Features

Horizontal scaling; HA/failover; real payment gateway (`PAYMENT_ENABLED=false`, charge returns 503 — **the platform cannot take money today**); real push/SMS providers wired for prod; `/metrics` scrape endpoint; alerting; load/soak test evidence; DR runbook with tested RTO/RPO.

## 21. Critical Bugs / Blockers

- **C1 — Cannot scale beyond one instance** (mutex + in-memory state + SQLite + no socket adapter). Launch-blocking for any HA/scale target.
- **C2 — Access-token revocation lost on restart / not shared** (`REVOKED_TOKENS` Map): suspended users regain access after a deploy. Security-critical.
- **C3 — Rate limiting resettable/bypassable** (in-memory): OTP/login brute-force at scale. Security-critical.
- **C4 — Payments non-functional in production** (`PAYMENT_ENABLED=false`; no gateway integrated): revenue path is a 503 placeholder.

## 22. High-Priority Issues

- A/B harnesses not in CI (compat guarantee unenforced).
- WAL unbounded growth. Socket.IO CORS `*` default. No migration framework. No `/metrics` exposition.

## 23. Medium-Priority Issues

- No API versioning/OpenAPI; no pagination on some admin lists; no schema-validation lib; metrics in-memory; Postgres/Redis provisioned-but-unused (misleading).

## 24. Low-Priority Issues

- Dead legacy files, empty dirs, stale root artifacts; duplicated payment-method catalog; mixed-language comments; `wallets` table unused.

## 25. Prioritized Roadmap

**Phase A — Security correctness (before ANY public launch):** move token revocation + rate limiting to Redis (C2, C3); set `SOCKET_CORS_ORIGIN` explicitly; add A/B harnesses to CI.
**Phase B — Make money work:** integrate a real payment gateway behind the existing `paymentGateway` port (C4); keep the ADR-001 idempotency invariants.
**Phase C — Scale substrate:** Postgres (ADR-001 Option E) + connection pool + versioned migrations; `@socket.io/redis-adapter`; remove the in-process mutex once Postgres provides row/tx isolation.
**Phase D — Ops maturity:** `/metrics` prom-client + alert rules + tracing; WAL/checkpoint or Postgres; DR runbook with tested restore; K8s/Helm once stateless.
**Phase E — Cleanup:** retire legacy routers, empty dirs, stale artifacts; add API versioning + OpenAPI; coverage gate.

## 26. Production Readiness Percentage

**~62%.** Weighted: architecture/code/tests/docs are 85–95%; security is ~70% (correct primitives, broken-at-scale state); scalability/cloud/K8s are 20–35%; payments 0% functional. **Green-light only for a controlled single-node, single-region pilot** (≤ ~1–5k users) **with Phase A security fixes done first.** Red-light for scale/HA/revenue.

## 27. Overall Engineering Score

| Category | Score |
|---|---|
| Architecture | 9.0 |
| Security | 6.5 |
| Performance | 6.0 |
| Scalability | 3.0 |
| Maintainability | 8.5 |
| Testing | 7.0 |
| Observability | 6.0 |
| Documentation | 8.5 |
| Deployment | 7.5 |
| Developer Experience | 8.0 |
| Reliability | 6.0 |
| Cloud Readiness | 3.0 |
| **Production Readiness (composite)** | **5.5** |

**Overall Engineering (craft-weighted): 7.5/10.** **Production-at-scale: 5.5/10.**

**Bottom line for the FAANG reviewer:** This is a beautifully layered, well-governed, well-tested
*single-node* application whose architecture is production-grade but whose *runtime* is not yet a
distributed system. Nothing here is unsalvageable — the boundaries are clean enough that the fixes
(Redis/Postgres/socket-adapter) are additive, not rewrites. **Do not approve a scaled or
revenue-taking launch until C1–C4 are closed.** A limited single-node pilot is defensible after
Phase A.

---
*All findings verified against the repository on 2026-07-20. No prior report was trusted; every claim above is traceable to a cited file or an executed command.*
