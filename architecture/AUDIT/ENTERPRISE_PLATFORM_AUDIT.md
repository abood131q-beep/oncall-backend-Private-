# OnCall Enterprise Platform — Independent Engineering Audit

**Auditor role:** External Principal Engineer — production-readiness assessment before global
rollout.
**Date:** 2026-07-21 · **Method:** independent verification against source (not a review of
prior claims). **Constraint:** read-only; no code changed. Some runtime checks (sqlite-backed
HTTP tests) require the app's native platform and were verified via CI configuration + static
analysis, not executed in this cross-arch environment (flagged where relevant).

**Repository scale (verified):** 538 `src/*.js` files · ~52,800 LOC · 208 HTTP endpoints ·
25 Enterprise kernels · 58 unit-test files · 16 integration/A-B harnesses · 36 ADRs.

---

## 1. Executive Summary

OnCall is **two systems in one repository** sharing one database:

1. A **mature, production-oriented legacy backend** (Express 5 + Socket.IO + SQLite/PG) that
   actually serves Flutter clients. It is well-hardened: parameterized SQL, constant-time JWT
   verification, helmet/CORS/rate-limiting, WAL + indexes, graceful shutdown, a strong CI with
   security audit + architecture-governance + A/B gates.
2. A **large, elegant Enterprise Platform** (25 kernels, Runtime/Host/Deployment, a Shadow
   Framework, G1.0 standard, 36 ADRs) that is **composed, health-checked, and shadow-verified —
   but delivers zero production behavior.** No kernel is authoritative; the legacy system owns
   100% of behavior, data, auth, and scheduling.

**The central finding is strategic, not defective:** an exceptional amount of high-quality
engineering (238 application files, 139 domain files, a full DDD/Clean-Architecture kernel set)
has been built and integrated in *shadow mode only*. The safety discipline is genuinely
world-class — flag-gated, reversible, parity-verified, byte-identical-when-off. But measured by
**delivered production value, the Enterprise Platform is currently net-zero** while carrying
large maintenance surface and two hard blockers (no DB-backed providers; no identity token
parity) that prevent any real migration.

**Verdict in one line:** the **legacy backend is conditionally production-ready today**; the
**Enterprise Platform is a verification-grade asset, not yet a production one**, and its ROI is
unproven until at least one kernel is promoted to authoritative. Approve rollout of the legacy
backend with the fixes below; do **not** treat the Enterprise integration as production
functionality yet.

---

## 2. Scorecard (0–100)

| Dimension | Score | One-line justification |
|---|---:|---|
| **Overall** | **76** | Excellent craftsmanship + safety; over-built relative to delivered value; a few real reliability/scaling gaps. |
| Architecture | 82 | Clean layering (verified), strong composition; but two-worlds duplication + speculative generality. |
| Code Quality | 78 | Consistent, linted, well-documented; god-files (`admin.js` 1,166 LOC) + hand-rolled crypto/env. |
| Security | 82 | Parameterized SQL, timing-safe JWT, headers-only tokens, secrets gitignored; hand-rolled JWT + a few gaps. |
| Performance | 75 | Indexes + WAL + async; SQLite single-writer is a hard ceiling. |
| Scalability | 66 | Single-node SQLite default; PG/Redis adapters exist but PG isn't wired into the live data path. |
| Maintainability | 74 | Great docs + shared framework; offset by 52k LOC, two worlds, 41 empty dirs, god-files. |
| Documentation | 92 | ADRs, G1.0, framework guide, phase/gap/remediation reports — exceptional and consistent. |
| Production Readiness | 70 | Legacy backend: high. Enterprise layer: shadow-only, blockers open, HTTP A/B unrun here. |
| Developer Experience | 86 | Strong CI, `verify:shadow`, scripts, and onboarding docs. |
| Enterprise Readiness | 72 | Framework + governance excellent; zero functional migration; ownership gates open. |

*Scores are the auditor's judgement; weighting favors correctness/security/readiness for a
global-rollout decision.*

---

## 3. Findings (severity-ordered)

### CRITICAL

**C-1 — The Enterprise Platform delivers no production value yet (strategic).**
- **File(s):** `src/platform/*`, `src/application/*` (238 files), `src/enterprise/*`,
  `architecture/*`.
- **Reason/Evidence:** every integrated kernel is shadow/non-authoritative; verified — no
  DB-backed providers exist (`find src/application -path '*/providers/*' | grep -i db` → empty;
  24 providers, all memory/file/env). `verify:shadow` confirms legacy is always returned.
- **Impact:** ~52k LOC + 25 kernels carry maintenance, cognitive, and CI cost while changing
  zero behavior. If migration never completes, this is sunk cost and permanent drag.
- **Recommendation:** commit to promoting **one** kernel (Configuration is lowest-risk) to
  *authoritative* behind a flag within a bounded timebox, to prove the ROI end-to-end; otherwise
  freeze further kernel integration. Do not add kernels 5–19 in shadow before proving one.
- **Fix difficulty:** High (organizational + B1/B2 blockers).

**C-2 — No DB-backed kernel providers (ownership blocker B1).**
- **File(s):** `src/application/*/providers/*` (all memory/file/env).
- **Evidence:** independent scan finds zero postgres/sqlite providers; ADR-047 documents the gate.
- **Impact:** **No stateful kernel (Storage, Rate Limiting, Notifications, Jobs, Identity) can
  ever become authoritative.** This is the true blocker to any functional migration.
- **Recommendation:** build one byte-compatible DB-backed provider over the *existing* tables
  (no schema change) with an A/B proof, per ADR-047 Gate B1. Start with the simplest (config or
  a read-model).
- **Fix difficulty:** High.

### HIGH

**H-1 — Scalability ceiling: SQLite single-writer is the default and the live path.**
- **File(s):** `database.js`, `src/config/database.js`, `docker-compose.prod.yml`.
- **Evidence:** default `DB_ENGINE=sqlite`; `dbGet/dbAll/dbRun` bind directly to sqlite3;
  `pg`/`postgresAdapter.js` exist but the **legacy data path does not use them** (the PG adapter
  is only referenced by the enterprise `migrator`/kernels, not by `config/database.js`).
- **Impact:** a single-writer embedded DB caps write throughput and prevents horizontal scale;
  "global rollout" on SQLite is unrealistic beyond modest load. `SQLITE_BUSY` JS-retry mitigates
  but does not remove the ceiling.
- **Recommendation:** wire the Postgres path into `config/database.js` (make `dbGet/dbAll/dbRun`
  dialect-aware) and run the A/B + integration suites against PG before global rollout. Treat PG
  as the production engine; SQLite for dev/edge only.
- **Fix difficulty:** Medium–High.

**H-2 — `unhandledRejection` does not terminate the process.**
- **File:** `server.js` (and mirrored in `src/app/onCallApplication.js` lifecycle).
- **Evidence:** `process.on('unhandledRejection', …)` only logs; only `uncaughtException` exits.
- **Impact:** an unhandled async rejection can leave the process running in an inconsistent
  state (leaked connections, half-finished transactions), masking bugs in production and
  contradicting fail-fast expectations. Node's roadmap defaults to crashing on this.
- **Recommendation:** log + crash (let the orchestrator restart) or route to a controlled
  graceful shutdown, matching `uncaughtException`. At minimum, alert on it.
- **Fix difficulty:** Low.

**H-3 — Hand-rolled security & config primitives (not-invented-here).**
- **Files:** `src/middleware/auth.js` (hand-rolled HS256 JWT), `src/config/env.js` (hand-rolled
  `.env` parser).
- **Evidence:** JWT is manually signed/verified with `crypto.createHmac` + `timingSafeEqual`;
  env is parsed by a bespoke line splitter.
- **Impact:** the JWT implementation is *currently correct* (hardcoded HS256 defeats alg-confusion;
  constant-time compare; `exp`/revocation checked) — but hand-rolled auth crypto is a standing
  assurance risk: no library audits, no `nbf`/`aud`/`iss`, easy to regress. The env parser lacks
  quoting/multiline edge-case coverage.
- **Recommendation:** migrate JWT to a vetted library (`jose`) behind the same interface; use
  `dotenv` for env. Both are low-risk, high-assurance swaps. (Note: this is exactly the kind of
  work the Identity kernel *should* eventually own — see ADR-047 Gate B2.)
- **Fix difficulty:** Medium.

**H-4 — Live HTTP A/B and DB-backed test suites unproven in this audit.**
- **Files:** `tests/integration/*-ab.mjs`, `integration-test.mjs`, DB-backed `tests/unit/*`.
- **Evidence:** these require the `sqlite3` native binding; they are wired into CI (`ab-compat`,
  `test` jobs, Node 24) but I could not execute them here (cross-arch). Only memory-only suites
  (85/85) and `verify:shadow` ran green in this environment.
- **Impact:** the end-to-end **byte-identity** guarantee and repository correctness are
  **asserted by design + CI config**, not observed in this audit. Until a green CI run exists on
  the pushed code, the byte-identity claim is unverified externally.
- **Recommendation:** push the branch (blocked only by A1's git-lock on the workstation) and
  attach the green CI run (`ab-compat` = `Result: IDENTICAL`) as the rollout gate.
- **Fix difficulty:** Low (execution/process).

### MEDIUM

**M-1 — Route god-files / weak modularization.**
- **Files:** `src/routes/admin.js` (**1,166 LOC**, ~41 endpoints), `src/routes/taxi.js` (697).
- **Impact:** high change-risk, hard review, merge contention, and a large blast radius per edit.
- **Recommendation:** split by resource (admin/users, admin/drivers, admin/fleet, admin/system).
  The layered `src/presentation/api/*` split already models this; finish migrating admin.
- **Fix difficulty:** Medium.

**M-2 — Admin authorization by phone allow-list.**
- **File:** `src/middleware/auth.js` (`authenticateAdmin`: `role==='admin' || ADMIN_PHONES.includes(phone)`).
- **Impact:** any valid token whose `phone` is in `ADMIN_PHONES` gains admin — including a
  passenger/driver token. Likely intentional, but it couples admin authz to a static env list
  and to token phone claims; rotation/offboarding is manual and error-prone.
- **Recommendation:** prefer explicit admin roles/records over a phone allow-list; if kept,
  document the threat model and ensure `ADMIN_PHONES` is tightly controlled.
- **Fix difficulty:** Low–Medium.

**M-3 — Two-worlds duplication and drift risk.**
- **Files:** `src/routes/*` (legacy) vs `src/presentation/api/*` (layered), toggled by `*_LEGACY`
  flags; plus legacy `src/repositories/*` vs `src/infrastructure/repositories/*Adapter.js`.
- **Impact:** two implementations of many contexts must be kept byte-identical (A/B harness
  guards this, but it is ongoing tax and cognitive load).
- **Recommendation:** set a deprecation date to retire one path per context once its A/B has been
  green in production for a defined soak, removing the flag and the legacy twin.
- **Fix difficulty:** Medium.

**M-4 — Shadow read-through inconsistency (minor API drift).**
- **File:** `src/platform-adapters/configuration/shadow.js` vs `.../observability/shadow.js`.
- **Evidence:** config's report uses `mismatches`; observability/jobs/scheduler use `mismatched`
  (surfaced by `verify-shadow.mjs`, which had to tolerate both).
- **Impact:** inconsistent report schema across shadows; brittle for dashboards/consumers.
- **Recommendation:** standardize the shadow report field names in the shared framework.
- **Fix difficulty:** Low.

**M-5 — `exec` (shell) for a fixed command.**
- **Files:** `src/routes/admin.js`, `src/infrastructure/gateways/adminOpsGateways.js` (`exec('df -k .')`).
- **Impact:** no user input is interpolated (not command injection), but `exec` spawns a shell
  unnecessarily; behind admin auth it is low risk.
- **Recommendation:** use `execFile('df', ['-k','.'])` to avoid the shell.
- **Fix difficulty:** Low.

### LOW

- **L-1 — 41 empty `.gitkeep` scaffolding directories** under `src/application/*`,
  `src/infrastructure/*`, `src/presentation/*` (e.g. `payments/`, `wallet/`, `mqtt/`, `maps/`) —
  dead scaffolding advertising unbuilt contexts; prune or build.
- **L-2 — Node engine pin (`>=24 <25`)** — correct in CI; ensure all dev machines match.
- **L-3 — Framework/docs drift risk** — G1.0 + Framework Overview must track `_shadow/` changes;
  no automated doc-sync check.
- **L-4 — No captured coverage numbers** — `test:coverage` runs `|| true` in CI (non-blocking);
  coverage is unquantified.
- **L-5 — SonarQube (`.scannerwork/`) present but results not surfaced** in the repo/deliverables.

---

## 4. Architecture Review

**Verified strengths**
- **Clean Architecture / layering holds.** Independent greps: `src/domain` imports no
  application/infrastructure; `src/application` imports no infrastructure directly. The repo's
  own governance gate (`architecture/compliance/verify-architecture.mjs`) passes **0 violations**
  across 426 enterprise files (R1 no-framework-in-core, R2 no-SQL-outside-infra, R3
  presentation-no-domain, R4 domain-pure, R5 application-downward-only, R6 no-cycles, R7
  ports-asserted).
- **Composition discipline** (ADR-042): kernels never import each other; the platform builder
  injects public services as `ports` in deterministic dependency order — genuinely well done.
- **Shadow Framework** (`_shadow/`): after 18.0, one canonical `deepEqual`/metrics, a generic
  round-trip verifier and a read-through verifier — a clean, reusable abstraction.

**Weaknesses / risks**
- **Speculative generality (over-engineering).** 25 kernels + Runtime/Host/Deployment for a
  single-tenant ride-hailing backend that currently uses none of them is a large bet on future
  need. Tenancy, Mesh, Resources, Discovery, Gateway have **no app mapping** and may never.
- **Two-worlds duplication** (M-3) is an architectural cost accepted for safety; it must be
  time-boxed, not permanent.
- **Missing abstraction where it matters:** the *legacy* data access (`config/database.js`) is
  not dialect-abstracted, so the PG readiness lives only in the enterprise layer — the part that
  isn't serving traffic (H-1).
- **DDD:** the enterprise domain layer is genuinely pure and well-modeled; the legacy app is more
  transaction-script style (fine for its role).

---

## 5. Security Review (OWASP-oriented)

| Area | Finding |
|---|---|
| **SQL Injection** | ✅ No interpolated/concatenated SQL found anywhere; all queries parameterized (`dbGet/dbAll/dbRun(sql, params)`). |
| **AuthN (JWT)** | ✅ Constant-time verify, length-guarded, `exp` + per-phone revocation checked, headers-only (no query tokens), HS256 hardcoded (defeats alg-confusion). ⚠️ hand-rolled (H-3); no `nbf/aud/iss`. |
| **Sessions / refresh** | ✅ Refresh tokens random + SHA-256 hashed at rest, rotation + revoke-all supported. |
| **AuthZ / IDOR** | ✅ Ownership checks present (e.g. socket `driver:location` verifies trip ownership). ⚠️ admin-by-phone allow-list (M-2). Recommend spot-testing per-resource authz across the 208 endpoints in CI. |
| **Rate limiting** | ✅ HTTP normal/login/phone limits (persisted phone locks) + per-socket 120/min on `driver:location`. |
| **Secrets** | ✅ `.env`, `*.db*`, `secrets/`, `.scannerwork/` gitignored (verified via `git check-ignore`); fail-fast if `JWT_SECRET` missing; Firebase via base64. |
| **Transport / headers** | ✅ helmet (CSP `default-src 'none'`), `X-Content-Type-Options`, `X-Frame-Options`, CORS allow-list + localhost dev. |
| **Socket.IO** | ✅ JWT `io.use` handshake auth; rejects tokenless; approval gating for drivers; per-socket rate limit. |
| **DoS / payload** | ✅ JSON body limit 1 MB; 413 handler. ⚠️ no explicit global request rate cap beyond the middleware; verify behind a proxy/WAF for global scale. |
| **PII in logs** | ✅ phone masking helper (`965*******`); security events log masked/limited fields. ⚠️ audit that no route logs full phone/PII at INFO. |
| **Command injection** | ✅ only fixed `df -k .` via `exec` (M-5, no user input). |
| **Supply chain** | ✅ minimal deps (7 prod); CI runs `npm audit --audit-level=high`. ⚠️ no captured audit result in this review. |
| **CSRF** | N/A for a token-in-header API + mobile clients (no cookie auth). |

**Net:** the security posture is **above average for a backend of this size** and shows evidence
of prior hardening passes (P6/H-fixes referenced in code). The main standing risks are
hand-rolled auth crypto (H-3) and admin-by-phone (M-2), plus the unproven end-to-end test run
(H-4).

---

## 6. Performance & Concurrency Review

- **Indexes:** 18 indexes across the schema — reasonable coverage; verify against actual query
  plans for the hot paths (trips by status/driver, taxis by driver_id) before global load.
- **Concurrency (SQLite):** `dbTransaction` uses `BEGIN IMMEDIATE` + JS-level `SQLITE_BUSY`
  retry with non-blocking `busyTimeout=0` — a correct pattern for sqlite3's single background
  thread. **But it is still a single writer** (H-1).
- **Async correctness:** fire-and-forget DB writes in the socket hot path attach `.catch`
  handlers; WAL checkpoint + backup timers are `.unref()`ed — good.
- **N+1 / query efficiency:** no obvious ORM N+1 (raw SQL); spot-audit the admin dashboard
  aggregates (`admin.js`) for per-row queries under load.
- **Memory:** metrics use bounded sliding windows (200 samples); shadow metrics bounded rings
  (100). Composing 25 memory-only kernels adds a small, one-time resident cost.
- **Socket scalability:** single-node by default; Redis adapter is optional (`REDIS_URL`).
  Multi-replica requires Redis for both the socket adapter and revocation fan-out — present but
  off by default; must be ON for horizontal scale.

---

## 7. Documentation & DX Review

- **Exceptional.** 36 ADRs, the G1.0 standard + Framework Overview, per-phase 6-doc sets,
  gap/remediation reports, CHANGELOG, README_DOCKER, release-please. Internal consistency is
  high (kernel counts, ADR references, flag names match code — spot-verified).
- **DX:** strong CI (security, lint, format, build, unit, MCP, architecture gate, A/B, coverage),
  `npm run verify:shadow`, deterministic scripts. Onboarding a new kernel engineer is genuinely
  well-supported.
- **Gaps:** coverage numbers not surfaced (L-4); no automated doc↔code sync (L-3); the
  documentation *volume* itself is now a maintenance surface that must track code.

---

## 8. Production Readiness — go/no-go by component

| Component | Ready for global rollout? |
|---|---|
| **Legacy backend (Express/Socket.IO)** | **Conditional GO** — after H-1 (PG in the live path), H-2 (rejection handling), and a green CI run (H-4). Security/hardening is solid. |
| **Enterprise Platform (shadow)** | **NO** as production functionality — it is verification-only. Safe to keep enabled (inert), but it must not be represented as delivering behavior. |
| **PostgreSQL** | **NOT READY on the live path** — adapter exists, not wired into `config/database.js` (H-1). |
| **Redis (multi-node)** | **Optional/ready** — wired for socket adapter + revocation; must be enabled + load-tested for horizontal scale. |
| **Docker/CI** | **Ready** — prod/monitoring/backup compose, strong CI; attach a green run. |

---

## 9. Final Verdict (brutally objective)

**What is world-class:**
- The **safety methodology** — Shadow Mode + feature flags + parity + coverage + confidence +
  rollback + A/B, codified in G1.0 with ADR governance — is exceptional and genuinely rare. The
  discipline that *no* integration changed production behavior (byte-identical when off) is
  exactly right.
- **Layering, composition, and documentation** are top-tier.

**What is over-built:**
- A 25-kernel Enterprise Platform for a single-tenant ride-hailing app that uses **none** of it
  in production is speculative generality. The ROI is **unproven**. Building 4 shadows produced
  verification confidence but **zero delivered functionality**. Continuing to shadow-integrate
  kernels 5–19 before promoting one to authoritative would compound sunk cost.

**What blocks production (of the *platform*):**
- No DB-backed providers (C-2/B1) and no identity token parity (B2) — the platform **cannot**
  own behavior or data. These are correctly gated by ADR-047 but remain unbuilt.

**What blocks production (of the *legacy app*, which is what ships):**
- SQLite single-writer as the live engine (H-1) and `unhandledRejection` non-termination (H-2)
  are real reliability/scale gaps; hand-rolled auth (H-3) is an assurance risk; and the
  end-to-end test run must be observed green (H-4).

**Recommendation to the CTO:**
1. **Approve global rollout of the legacy backend** only after H-1, H-2, H-4 (and ideally H-3),
   on **PostgreSQL + Redis**, with a green CI run attached.
2. **Do not present the Enterprise Platform as production capability.** Fund a **time-boxed
   proof**: promote **one** kernel (Configuration) to authoritative behind a flag, clearing
   ADR-047 Gate B1 for it, and measure the ROI. If it succeeds, continue; if not, **freeze the
   platform in shadow** and stop adding kernels.
3. **Set retirement dates** for the two-worlds duplication (M-3) so the safety scaffolding does
   not become permanent tax.

The engineering *quality* here is high and the *safety* is outstanding; the risk is **strategic
over-investment in an unproven platform** while the shipping system still needs its database and
reliability story finished. Close that gap first.

---

*End of audit. Read-only assessment; no files were modified. Runtime items requiring the native
sqlite binding were assessed via CI configuration and static analysis and are flagged as
externally-unverified (H-4) pending a green CI run.*
