# Changelog

All notable changes to the OnCall backend are documented here. This file is **seeded manually**
for the Enterprise integration work and is maintained going forward by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/) on merges to `main`.

The format follows [Keep a Changelog](https://keepachangelog.com/). Versioning is SemVer; the
version in `package.json` is owned by release-please and bumped on release-PR merge.

## 1.0.0 (2026-07-22)


### Features

* **14.1:** add Consumer Inbox — exactly-once effect (Outbox→Broker→Inbox→Handler) ([affee9c](https://github.com/abood131q-beep/oncall-backend-Private-/commit/affee9ca2eb76781202fcb91b65b47a8a5c74c8f))
* **14.1:** additive in-process event backbone (DomainEvent + eventBus) ([b53125a](https://github.com/abood131q-beep/oncall-backend-Private-/commit/b53125a905566830467bec59981db89141824bf2))
* **14.1:** close event-backbone review gaps (outbox, contracts, correlation, store, publisher port) ([4f5e5ce](https://github.com/abood131q-beep/oncall-backend-Private-/commit/4f5e5cef68bd83b72d7a4f32e6ee5dfeb6a1caa8))
* **14.2:** Enterprise Extension Platform (manifest, registry, sandbox, hooks, DI ports) ([f3e215f](https://github.com/abood131q-beep/oncall-backend-Private-/commit/f3e215fe5b1ffa126ff78156f49a92cf77504e1b))
* database layer — schema, WAL setup, and safe migrations ([1851efc](https://github.com/abood131q-beep/oncall-backend-Private-/commit/1851efca5efbe871325de3a0f3d0fc4be7b80b65))
* enterprise clean-architecture migration + production hardening ([5e458a5](https://github.com/abood131q-beep/oncall-backend-Private-/commit/5e458a54ee09dc5bc1ba49989d803dcc278ad7b8))
* payment routes — fare estimation, wallet, payment gateway flag ([40aa691](https://github.com/abood131q-beep/oncall-backend-Private-/commit/40aa691d57c8309e5eeaffdf5d02d2099ff4129e))
* repository layer — data access with security fixes ([026843a](https://github.com/abood131q-beep/oncall-backend-Private-/commit/026843a681a5d9b853198e3f37afe5ada4155a64))
* server entry point — DI wiring, global error handler, graceful shutdown ([4875526](https://github.com/abood131q-beep/oncall-backend-Private-/commit/487552656484653647420b219d61974efad7eb59))
* services — backup, cache, fare, analytics, places, payment, driver matching ([778021f](https://github.com/abood131q-beep/oncall-backend-Private-/commit/778021fc075236f126d949c1eeb9ae94842d00fa))
* utilities — logger with stack traces, input validation helpers ([d882770](https://github.com/abood131q-beep/oncall-backend-Private-/commit/d8827706b6ef4b29c5eeed22c68ad5de13883258))


### Bug Fixes

* admin routes — FK fix, dashboard crash, parallel PRAGMA lock, stats accuracy ([fb8a90a](https://github.com/abood131q-beep/oncall-backend-Private-/commit/fb8a90a148afc808cadd64339cca616d3d4ee50b))
* auth, health, users, drivers routes — JWT revocation, validation, IDOR ([64cae6a](https://github.com/abood131q-beep/oncall-backend-Private-/commit/64cae6ae3e505510d214f93963ea67cd1064d39b))
* auth/verify accepts Authorization header; charge validates input before gateway check ([0666077](https://github.com/abood131q-beep/oncall-backend-Private-/commit/0666077ef3c9753f3b027479962e561c0e785f11))
* **ci:** ADMIN_PHONES for driver/admin E2E; A/B volatile-field normalization + engine-ab routing; Postgres host-TCP readiness (fix restart race); Docker smoke prod-valid SMS config ([8e2c9c7](https://github.com/abood131q-beep/oncall-backend-Private-/commit/8e2c9c72de14aa1e3cd35b44c9cf6859b8f448e5))
* **ci:** ADMIN_PHONES for run_tests.sh driver/admin E2E (WARN-&gt;PASS); normalize volatile /health,/metrics in A/B harnesses; route engine-ab to postgres job ([a9ac31e](https://github.com/abood131q-beep/oncall-backend-Private-/commit/a9ac31e8316dad8dc6df4534fc11d619f9491ac0))
* **ci:** parser ignores run_tests summary tally lines (0 real fails); postgres step5 reporter-agnostic (Node24); Docker builds sqlite3 from source to match runtime glibc ([4dc6ce0](https://github.com/abood131q-beep/oncall-backend-Private-/commit/4dc6ce07a29d27430ec90921b8da1d3777e3d311))
* **ci:** unref housekeeping timers (metrics/cache) end 6h Backend Tests hang; fast-uri 3.1.4 (HIGH); job timeouts + test-timeout + parallel gates ([7c39fa9](https://github.com/abood131q-beep/oncall-backend-Private-/commit/7c39fa9308ba3165c65855d598d1ecaaa4d21c32))
* enforce ownership checks on trip and wallet endpoints ([00d105e](https://github.com/abood131q-beep/oncall-backend-Private-/commit/00d105e7f7b119a7ba4482b62e2cf9864ac881fe))
* **L1,L-002,L-005:** remove dev HTML, log logins, fix safeJSON ([7ec270f](https://github.com/abood131q-beep/oncall-backend-Private-/commit/7ec270fb0e4250e873348356802d05bc27176a87))
* **M1,M11:** validate scooter coords on create; deprecate /scooter/rent ([fc8bbdb](https://github.com/abood131q-beep/oncall-backend-Private-/commit/fc8bbdb3cf84d6be8e84b665d0aaaeb16a049be3))
* **pg:** add trips.updated_at + dev-only demo seed (taxis/scooters/user) for SQLite≡PostgreSQL cross-engine parity ([72f7aa3](https://github.com/abood131q-beep/oncall-backend-Private-/commit/72f7aa3e027ef7e0d336713a0aa9ee391d1391cb))
* **production:** 4 critical/high bugs found in full audit ([70e04de](https://github.com/abood131q-beep/oncall-backend-Private-/commit/70e04de1977150ffe5ebe8f7feca24db5889f2cb))
* **rate-limit:** add retryAfter to phoneLoginLimit 429 responses ([a24f5b8](https://github.com/abood131q-beep/oncall-backend-Private-/commit/a24f5b8dd370ada49c89e0301879525e3ea5b13c))
* reject duplicate and non-completed trip ratings with 409/400 ([6e6c9d7](https://github.com/abood131q-beep/oncall-backend-Private-/commit/6e6c9d77703ed0ed6da241d2f0e0e87ff75cd939))
* scooter routes — IDOR, atomic payment, deprecated endpoint ([30acef9](https://github.com/abood131q-beep/oncall-backend-Private-/commit/30acef99454350e5d1962e565fafcd2356bbc2fe))
* security middleware — JWT, rate limiting, CSP, timing attack ([817ed99](https://github.com/abood131q-beep/oncall-backend-Private-/commit/817ed993fd2f365c5be85e896a46693959de6cdd))
* set payment_status='completed' after successful payment on trip finish ([ad70fee](https://github.com/abood131q-beep/oncall-backend-Private-/commit/ad70feede617c1a6be9d8beb14139b23f0cbcaea))
* Socket.IO — auth middleware, rate limiting, ownership checks, FK fix ([93e0422](https://github.com/abood131q-beep/oncall-backend-Private-/commit/93e04229288d6660677e63b3fcf2989aba42470c))
* sync driver DB status on socket register + reject duplicate ratings ([bc01b1d](https://github.com/abood131q-beep/oncall-backend-Private-/commit/bc01b1dbb45245323b70bbc0df5a85d4d6f06b3e))
* taxi routes — FK fix, coord validation, IDOR, ownership enforcement ([15a2c4d](https://github.com/abood131q-beep/oncall-backend-Private-/commit/15a2c4deccd42b4edfe6e4801cb485111b931979))

## [Unreleased]

### Added — Configuration Kernel Authoritative Promotion (Phase 18.5, ADR-048, flag-gated, default OFF)

- **First Enterprise kernel promoted past Verified.** The runtime config facade
  (`src/config/index.js`) can now serve reads from the **Configuration Kernel snapshot** when
  `CONFIG_AUTHORITATIVE=1`, with **mandatory `env.js` fallback** on any miss/fault. Default OFF ⇒
  byte-identical to 18.4. Rollback is flag-only (`CONFIG_AUTHORITATIVE=0`).
- **Synchronous snapshot** (`src/platform-adapters/configuration/authoritativeSource.js`) built at
  bootstrap from the env seed via the kernel's own `precedence.resolve` (no async in `config.get()`,
  no boot-order change; value references preserved ⇒ byte-identical reads).
- **A/B + fault injection:** `tests/integration/config-authoritative-ab.mjs` (CI `ab-compat`,
  byte-identical HTTP OFF vs ON) + `tests/unit/configAuthoritative.test.js` (11/11: value identity,
  rollback, and all four fallback paths). Configuration shadow parity remains **100%** with the flag
  ON. `env.js` retained as bootstrap source, mandatory fallback, and emergency recovery.
- Docs: **ADR-048**, `architecture/phase-18.5/PRODUCTION_SOAK_PLAN.md`,
  `architecture/PROMOTION_HISTORY.md`.

### Added — Runtime Configuration Facade & Migration (Phase 18.3–18.4)

- **18.3 Runtime Configuration Read Facade** (`src/config/index.js`, `config.get`/`config.require`)
  — the single approved config-read seam; architecture rule **R8** enforces it (ratchet).
- **18.4 Migration complete** — every runtime consumer reads via the facade; **R8 allowlist = 0**;
  only `env.js`, the facade, and the Configuration shadow's legacy source read `env.js` directly.

### Added — Enterprise Shadow Integration (Phase 17.x, all additive & flag-gated, default OFF)

- **17.2 Hosted Service & Adapter Layer** — the unchanged OnCall backend now runs as a single
  Enterprise Hosted Service (`src/hosted-service/onCallAppService.js`) on the ADR-043 Runtime /
  ADR-044 Host, selected by `PLATFORM_ENABLED` + `PLATFORM_HOST`. Introduced
  `src/platform-adapters/` (the only app↔kernel seam) and `src/app/onCallApplication.js`
  (behavior-identical extraction of the app wiring from `server.js`).
- **17.3 Configuration Kernel shadow** (ADR-019) — `PLATFORM_CONFIG` / `SHADOW_CONFIG`;
  read-through parity, legacy `env.js` authoritative; parity 100%.
- **17.4 Observability Kernel shadow** (ADR-033) — `PLATFORM_OBSERVABILITY` /
  `SHADOW_OBSERVABILITY`; parity 100%; isolated shadow metrics.
- **17.5 Jobs Kernel shadow** (ADR-032) — `PLATFORM_JOBS` / `SHADOW_JOBS`; never executes a job
  (never ticks); parity + coverage 100%.
- **17.6 Scheduler Kernel shadow** (ADR-020) — `PLATFORM_SCHEDULER` / `SHADOW_SCHEDULER`; never
  arms a timer / never executes; parity + coverage 100%. Introduced the shared **generic
  round-trip verifier** (`src/platform-adapters/_shadow/`) and refactored Jobs onto it.
- **G1.0** — Enterprise Shadow Integration Standard + Framework Overview
  (`architecture/G1.0/`).

### Governance

- **G1.0** ratified by **ADR-046**; ownership-promotion preconditions recorded in **ADR-047**.

### Engineering / stabilization (Phase 18.0)

- Unified Configuration (17.3) and Observability (17.4) shadows onto the shared metrics
  (`confidenceLevel` + `coveragePct`) and shared `deepEqual`; extracted a shared read-through
  verifier. No behavior/parity change.
- Added `npm run verify:shadow` — a sqlite-free, run-anywhere shadow-parity gate, wired into CI.

### Guarantees (unchanged behavior)

- With all `PLATFORM_*` / `SHADOW_*` flags OFF (the default), runtime, API, startup, shutdown,
  authentication, database schema, and Socket.IO behavior are **byte-identical** to the
  pre-integration backend. No Enterprise kernel is authoritative; the legacy platform remains
  the single source of truth.

---

*Older release history (P6/P7 hardening, Phase 12 observability, etc.) predates this file and is
recorded in git tags / GitHub Releases.*
