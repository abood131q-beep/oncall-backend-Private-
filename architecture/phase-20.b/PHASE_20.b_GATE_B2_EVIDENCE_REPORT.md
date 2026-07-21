# Phase 20.b (cont.) — Gate B2 Evidence Generation — Report

## Executive Summary

Building on the live shadow integration, this step produced **real, measured** ADR-047 Gate B2
evidence. A key discovery unblocked most of it: the repo's dev preload `tools/dev/sqlite3-compat.js`
lets the **real server boot in this environment** (mapping `sqlite3` onto `node:sqlite`), so the
HTTP + refresh/revocation A/B and the rollback drill run **here**, not only in CI. Result: **4 of the
5 Gate B2 evidence items are measured PASS**; only **cross-replica revocation timing** remains
UNAVAILABLE (needs Redis + ≥2 replicas → staging). **Gate B2 is SUBSTANTIALLY MET but NOT fully MET
— no promotion.** Legacy identity stays authoritative; all flags default OFF; production unchanged.

## Measured evidence (this environment)

| Gate B2 item | Harness | Result |
|---|---|---|
| B2.1 token/claims + verify parity (pure) | `scripts/identity-parity-report.mjs` | ✅ **PASS** — 100%, 0 mismatch |
| B2.1 HTTP lifecycle byte-identical (shadow OFF vs ON) | `tests/integration/identity-http-ab.mjs` | ✅ **IDENTICAL** — 24 steps (login/verify/is-admin/driver/refresh/logout) |
| B2.1 **refresh + revocation** byte-identical | same (refresh rotation, replay-revoked, logout-revoked, logout-all-revoked) | ✅ **IDENTICAL** |
| B2.socket decision parity (OFF vs ON) | `tests/integration/identity-socket-ab.mjs` | ✅ **IDENTICAL** |
| B2.3 rollback-safety (session survives flag flip, no re-auth) | `scripts/identity-rollback-drill.mjs` | ✅ **PASS** (PARTIAL — authoritative-flag flip completes in 20.c) |
| B2.2 cross-replica revocation timing | `tests/integration/identity-cross-replica-revocation.mjs` | ⏳ **UNAVAILABLE** — needs `REDIS_URL` + ≥2 replicas (staging) |

The HTTP A/B boots **two real servers** (shadow OFF vs ON) on fresh DBs and drives the full identity
lifecycle with token/timestamp normalization (reusing `identity-ab.mjs`'s proven machinery) — every
`(status, body)` pair is byte-identical, including all refresh-rotation and revocation steps.

## What changed

- `tests/integration/identity-http-ab.mjs` — rebuilt into a full-lifecycle HTTP + refresh/revocation
  A/B (shadow OFF vs ON) via the compat preload; **runs here + CI**.
- `tests/integration/identity-cross-replica-revocation.mjs` — staging harness (skip-clean without
  `REDIS_URL`).
- `scripts/identity-rollback-drill.mjs` — rollback-safety drill (runs here); writes evidence.
- `scripts/identity-gate-b2.mjs` — now runs all suites and aggregates measured results into
  `evidence/gate-b2-evidence.json`; never over-claims (PARTIAL/UNAVAILABLE preserved).
- `.github/workflows/ci.yml` — `ab-compat` job now runs `npm run identity:gate-b2` and uploads the
  evidence artifact; the identity A/B harnesses are already auto-run by `test:ab`.
- npm scripts: `identity:gate-b2`, `identity:parity-report`, `identity:rollback-drill`,
  `identity:cross-replica`, `verify:identity-shadow`.
- Evidence artifacts: `architecture/phase-20.b/evidence/{identity-parity-report,gate-b2-evidence,rollback-drill-evidence}.json`.

Note: a standalone `identity-refresh-revocation-ab.mjs` was intentionally **not** created — the
enhanced `identity-http-ab.mjs` already exercises refresh/rotation/replay/logout/logout-all revocation
byte-identically, which is the same evidence, verified end-to-end against a real DB.

## Validation

| Check | Result |
|---|---|
| Architecture R1–R8 | ✅ PASS (0 violations) |
| ESLint (project scope) | ✅ PASS |
| Unit regression | ✅ 901/901 |
| Other shadows + Config authoritative | ✅ unchanged (`verify:shadow` PASS) |
| Legacy `middleware/auth.js` / OTP / gateways | ✅ unchanged |
| Production behavior (flags OFF) | ✅ byte-identical (proven in 20.b: not mounted when OFF) |

## Gate B2 verdict (from `gate-b2-evidence.json`)

**SUBSTANTIALLY MET — not fully MET.** Token/claims + HTTP + refresh/revocation + socket measured
PASS; rollback-safety measured PASS (B2.3 PARTIAL — authoritative-flag rollback in 20.c); **B2.2
cross-replica timing UNAVAILABLE** here. Per ADR-047, **do not promote** until B2.2 is produced in
staging and B2.3 is completed with the 20.c authoritative flag, plus an Owner-signed ADR-050.

## Readiness

Ready for **Phase 20.c (Feature Flag validation)**: introduce `IDENTITY_AUTHORITATIVE` (default OFF),
complete the rollback drill against it, and produce the B2.2 cross-replica evidence in staging
(runbook: `RUNBOOK_cross_replica_and_rollback.md`). Then Gate B2 = MET → Production Soak → ADR-050 →
Authoritative Promotion.

## Host actions

Commit on the host. In staging, run `npm run identity:cross-replica` (with `REDIS_URL`) to finish
B2.2; the CI `ab-compat` job now produces + uploads the rest of the Gate B2 evidence automatically.
