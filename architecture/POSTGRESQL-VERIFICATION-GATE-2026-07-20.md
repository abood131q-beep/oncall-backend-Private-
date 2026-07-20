# PostgreSQL Verification — Reports + Go/No-Go Decision

**Engineer:** Chief Database Architect · **Date:** 2026-07-20 · **Objective:** execute + prove PostgreSQL in a REAL runtime.

## 0. Bottom line (honest, up front)

**DECISION: NO-GO — not because PostgreSQL failed, but because it was NOT EXECUTED.**
I could **not provision a real PostgreSQL instance in this sandbox**, and per your own success
criterion ("Do not declare success until PostgreSQL has been executed successfully in a real
runtime"), I will not declare success. I attempted every provisioning path and hit hard,
evidence-backed walls. I built the exact one-command gate so you can complete the verification in an
environment that has Postgres (your Mac / CI) — it is the missing 8%.

## 1. Provisioning attempts (all blocked — with evidence)

| Attempt | Result | Evidence |
|---|---|---|
| Pre-installed Postgres binaries | none | `which postgres pg_ctl initdb psql` → empty; `/usr/lib/postgresql` absent |
| Docker | unavailable | `which docker` → empty |
| `sudo apt-get install postgresql` | blocked | `sudo: The "no new privileges" flag is set … cannot run as root` |
| Am I root? | no | `id` → `uid=1002(busy-awesome-fermi)`; `/usr/lib` not writable |
| Rootless `apt-get download postgresql-14 …` | **403 Forbidden** | `Failed to fetch http://ports.ubuntu.com/…/postgresql-14_…arm64.deb 403 Forbidden [IP: 127.0.0.1 3128]` — allowlist proxy blocks the mirror |
| `pg` npm module (pure JS) | uninstallable | npm registry blocked (same allowlist); `node -e "require('pg')"` → Cannot find module |

This is a **locked-down execution sandbox** (no root, no docker, allowlist egress). There is no
mechanism available to me here to run a real PostgreSQL. I did not stop at the first failure — I
exhausted binaries, docker, sudo, rootless `.deb` extraction, and the npm path.

## 2. What IS verified (executed here, real)

The engine/dialect/migration code is complete and the parts that DON'T need a live DB are proven:

- **Dialect translator** — pure `toPostgres()`, **9 executed unit tests** + live edge-case probes:
  - `UPDATE trips SET end_time = datetime('now') WHERE id = ?` → `… end_time = NOW() WHERE id = $1` ✅
  - `SELECT strftime('%H', created_at) … WHERE created_at >= datetime('now','start of day') …` →
    `to_char(created_at,'HH24') … >= date_trunc('day', NOW()) …` ✅
  - `RETURNING id` appended only for serial-id tables; phone-PK tables excluded ✅
- **Engine selector** (`DB_ENGINE`): default → sqlite with the exact 4-helper contract; `postgres`
  branch reached (stops only at the blocked `require('pg')`).
- **Zero regression on SQLite (the baseline):** verifier **0 violations**, **194/194** unit,
  **10/10** A/B byte-identical, lint/format clean — the migration seam broke nothing.
- **New artifacts, syntax-checked:** `tests/integration/engine-ab.mjs` (SQLite-vs-PG A/B),
  `scripts/verify-postgres.sh` (`node --check` / `bash -n` clean).

## 3. The gate you must run (turns NO-GO → GO)

Everything is packaged into ONE command that provisions a throwaway Postgres, migrates, and runs the
cross-engine A/B + unit + verifier, then tears down:

```bash
npm run verify:pg      # = bash scripts/verify-postgres.sh  (needs Docker + network)
```

It performs, in order:
1. `npm install pg` (pure JS — no native build).
2. `docker run postgres:16-alpine` (throwaway, port 5433).
3. `DB_ENGINE=postgres DATABASE_URL=… npm run migrate` → applies `migrations/0002_core_schema.pg.sql`.
4. Architecture verifier.
5. `npm run test:unit`.
6. **`tests/integration/engine-ab.mjs`** — boots the server on SQLite AND on PostgreSQL, runs an
   identical 21-scenario suite across identity/fleet/trips/admin/commerce/notifications/localization,
   and diffs every (status, body) byte-for-byte. **PASS iff it prints `N/N byte-identical (SQLite ≡
   PostgreSQL)`.**

Manual equivalent (if you prefer your own Postgres):
```bash
npm install pg
createdb oncall_test
DB_ENGINE=postgres DATABASE_URL=postgres://…/oncall_test npm run migrate
PG_URL=postgres://…/oncall_test node tests/integration/engine-ab.mjs
```

## 4. PostgreSQL Verification Report — **PENDING (blocked in this env)**

Every item below is gated on §3 executing. I will not mark any ✅ I did not run:
REST endpoints · Socket.IO events · repositories · transactions · migrations · indexes · constraints
· JSON-vs-SQLite comparison → **all PENDING the live run**. (Design + unit-level correctness: done §2.)

## 5. API Compatibility Report — engineered, live-unverified

The compatibility mechanics (id→number, money→DOUBLE PRECISION not NUMERIC, 0/1 INTEGER flags,
TIMESTAMPTZ→SQLite-text coercion, ALS transaction context) are implemented and unit-tested; the
end-to-end byte-identity assertion is exactly what `engine-ab.mjs` checks. **Live result: PENDING.**

## 6. Performance Comparison — **not measurable here**

No live PG ⇒ no honest numbers. Expectation (to be measured by a staging k6 run): marginally higher
per-query latency (network + planner) vs SQLite, offset by the removal of the single-writer ceiling
and multi-replica scaling. **No performance claim asserted.**

## 7. Production Go/No-Go Decision

**NO-GO (verification incomplete).** Rationale: the code is production-grade and the SQLite baseline
is regression-free, but the mission's gate — PostgreSQL executed in a real runtime with a passing
SQLite≡PG A/B — has **not run** because this environment cannot host Postgres. Flip to **GO** the
moment `npm run verify:pg` prints an all-green `N/N byte-identical (SQLite ≡ PostgreSQL)` (plus
unit + verifier green), which is expected given the unit-proven translation but must be observed, not
assumed.

**Confidence that the gate will pass when run:** high for reads/writes/transactions/auth (the dialect
+ ALS + type coercion cover the surveyed surface); the top watch-items to eyeball in the A/B output
are datetime string formatting and any numeric-as-string leak — both engineered for, both exactly
what the harness would catch.

---
*I did not fake a PostgreSQL run. Provisioning was attempted through every available path and blocked
by the sandbox's no-root + allowlist-proxy policy (evidence in §1). The verification is packaged as a
single reproducible command (`npm run verify:pg`); run it where Docker/Postgres exists to close the
gate. Until then: NO-GO, honestly.*
