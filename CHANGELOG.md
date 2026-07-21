# Changelog

All notable changes to the OnCall backend are documented here. This file is **seeded manually**
for the Enterprise integration work and is maintained going forward by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/) on merges to `main`.

The format follows [Keep a Changelog](https://keepachangelog.com/). Versioning is SemVer; the
version in `package.json` is owned by release-please and bumped on release-PR merge.

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
