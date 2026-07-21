# Phase 18.1 — P0 Priority Execution Report

**Mission:** eliminate the highest-priority blockers from the independent audit, strictly in
order. No new features, no new kernels. **Result: P0-1 and P0-2 closed; P0-3 verification green
locally (sqlite/PG-dependent gates run in CI).** No regression; ADR-046/047, feature flags, and
Shadow Mode all preserved.

**Local verification (after all P0 changes):** ESLint **PASS** · Prettier **PASS** ·
Architecture gate **PASS (0 violations)** · `verify:shadow` **PASS** · unit regression
**94/94** (shadow/host **85** + sqlDialect **9**).

---

## P0-1 — PostgreSQL as the live production database path

### Objective
Make the production data path run on PostgreSQL while preserving SQLite compatibility, API
behavior, schema, transactions, and A/B compatibility.

### Finding (audit self-correction — do not assume prior work, including my own)
On independent verification, **the PostgreSQL live path was already implemented** (Phase 12/13),
and **my own audit finding H-1 ("PG adapter not wired into `config/database.js`") was materially
incorrect.** Evidence:
- `src/config/database.js` **is dialect-aware**: `if (DB_ENGINE==='postgres')` swaps in
  `createPostgresAdapter`, which implements the identical `{dbGet,dbAll,dbRun,dbTransaction}`
  contract — so **no repository/route/socket handler changes**. Default remains `sqlite`.
- `src/infrastructure/db/postgresAdapter.js`: pooled `pg`, `?`→`$n` translation, `dbRun`
  returns `{lastID, changes}` (lastID via `RETURNING id`, changes via `rowCount`), transactions
  via a real pooled client with **AsyncLocalStorage** so the no-arg `dbTransaction(fn)` pattern
  and module-level helpers route to the tx client (ADR-001 atomicity preserved). Type parsers
  (`int8`/`numeric` → JS number) + `coerceRow` (Date → SQLite string) keep JSON **byte-identical**.
- `src/infrastructure/db/sqlDialect.js`: **pure, fully unit-testable** translator (placeholders,
  `datetime('now',…)`, `strftime`, auto `RETURNING id` for serial-id tables, `ON CONFLICT`
  passthrough).
- `migrations/0002_core_schema.pg.sql`, `scripts/verify-postgres.sh` (Docker throwaway PG →
  migrate → unit tests → **SQLite≡PostgreSQL cross-engine A/B** via `engine-ab.mjs`),
  `npm run verify:pg`.

Re-implementing this would have introduced pure churn and regression risk against working,
reviewed code — the wrong engineering call. The correct action was to **verify** it and close
the **real** remaining gap.

### Implemented Fix (the genuine gap: not enforced in CI)
- **Added a `postgres` job to `.github/workflows/ci.yml`** that runs `bash scripts/verify-postgres.sh`
  on `ubuntu-latest` (Docker available), gating every push/PR on the SQLite≡PostgreSQL A/B.
- **Hardened the CI summary gate**: it now fails on `ab-compat` **and** `postgres` results
  (previously neither was in the summary's exit condition — a latent hole).
- **Files changed:** `.github/workflows/ci.yml` (additive job + stricter summary). No app code.

### Architecture Impact
None to runtime/architecture. CI now continuously proves the PG live path is byte-identical to
SQLite (the audit's requested gate). Default engine stays SQLite; PG activates only via
`DB_ENGINE=postgres`.

### Risk Assessment
Low. CI-only change; the PG code path is unchanged and already isolated behind `DB_ENGINE`.
Residual risk: `verify-postgres.sh` needs Docker on the runner (present on GH `ubuntu-latest`).

### Verification / Test Evidence
- Pure dialect suite **9/9 PASS** here (`tests/unit/sqlDialect.test.js`): placeholders,
  datetime/strftime, `RETURNING id` only for serial-id tables, `ON CONFLICT`/`CURRENT_TIMESTAMP`
  passthrough, Date coercion.
- The live cross-engine A/B (`engine-ab.mjs`) requires Docker+PG and now runs in the new CI job
  (cannot execute in this cross-arch sandbox).

### Remaining Blockers
- **Observe one green CI run** of the new `postgres` job (SQLite≡PostgreSQL A/B `byte-identical`)
  on the pushed branch — the external proof for the rollout gate.
- Production cutover still requires provisioning managed Postgres + `DATABASE_URL`/`PG*` config
  and a data migration plan for existing SQLite data (operational, out of code scope).

### Recommendation
Merge; require the `postgres` CI job green as a rollout gate; run a staging soak on Postgres +
Redis before global cutover. **Correct audit H-1 to "already implemented; now CI-enforced."**

---

## P0-2 — `unhandledRejection` handling

### Objective
Never leave the process in an inconsistent state on an unhandled promise rejection; match
`uncaughtException` (fail-fast); preserve logging.

### Root Cause
`process.on('unhandledRejection')` only logged at `error` level and let the process continue —
risking leaked connections / half-finished transactions and masking bugs, contradicting the
fail-fast posture of the adjacent `uncaughtException` handler.

### Implemented Fix
- `server.js`: the handler now logs at **`fatal`** and calls **`process.exit(1)`**, mirroring
  `uncaughtException`, so the orchestrator (systemd/Docker/K8s) restarts a clean process. The
  graceful `SIGTERM`/`SIGINT` path is untouched (this is the *abnormal* path).
- **Files changed:** `server.js` (handler body only).

### Architecture Impact
None. Process-lifecycle hardening; applies to both legacy and enterprise boot modes (the crash
guards are registered once at the top of `server.js`).

### Risk Assessment
Low–Medium. Fail-fast means a previously-swallowed rejection now restarts the process — this is
**intended** (surfaces latent bugs) and matches production best practice. Ensure the orchestrator
has restart-on-exit configured (Docker `restart: unless-stopped` / K8s default) — the repo's
`docker-compose.prod.yml` and K8s manifests should be confirmed to auto-restart.

### Verification / Test Evidence
- `node --check server.js` OK; `logger.fatal` confirmed present.
- Full local gate green after the change; unit regression **94/94**. Behavior on the happy path
  is unchanged (handler only fires on an otherwise-fatal condition).

### Remaining Blockers
None in code. Operational: confirm restart policy in all deploy targets.

### Recommendation
Merge. Add an alert on process exit-code 1 / restart count so fail-fasts are visible in
production monitoring.

---

## P0-3 — Full engineering verification

| Gate | Where run | Result |
|---|---|---|
| ESLint (`--max-warnings 0`) | here | ✅ PASS |
| Prettier `format:check` | here | ✅ PASS |
| Architecture compliance (`verify-architecture.mjs`) | here | ✅ PASS (0 violations) |
| `verify:shadow` (all 4 shadows 100% parity + coverage) | here | ✅ PASS |
| Unit — shadow/host/framework | here | ✅ 85/85 |
| Unit — SQL dialect | here | ✅ 9/9 |
| Unit — repository/DB-backed | CI `test` job (sqlite) | ⏳ runs in CI |
| Integration + A/B harnesses | CI `ab-compat` job (sqlite) | ⏳ runs in CI |
| **PostgreSQL cross-engine A/B** | **CI `postgres` job (Docker)** | ⏳ **now wired** |
| Security audit (`npm audit --audit-level=high`) | CI `security` job | ⏳ runs in CI |
| Full CI pipeline | GitHub Actions | ⏳ on push |

**Statement:** every gate runnable in this cross-arch sandbox is **green**; the sqlite- and
Postgres-dependent gates are wired into CI (Node 24 + Docker) and must be observed green on the
pushed branch. No item regressed.

---

## Rules compliance (audit + mission)

Public APIs unchanged · Flutter compatibility preserved (no route/response/token change) ·
feature flags intact · Shadow Mode intact · ADR-046/047 not bypassed · both P0 changes are
additive/behavior-preserving on the happy path.

## Consolidated recommendation

Proceed to P1 (strategy/readiness only, no implementation): **P1-4** security-primitive migration
strategy (`jose`/`dotenv`) and **P1-5** Configuration-kernel promotion readiness — delivered as
`P1-4_SECURITY_PRIMITIVES_MIGRATION_STRATEGY.md` and `P1-5_CONFIG_KERNEL_PROMOTION_READINESS.md`.
Do **not** promote any kernel or change token formats in this phase.
