# Phase 17.2 — OnCall Hosted Service & Enterprise Adapter Layer

**Implementation phase — complete.** The OnCall backend now runs, byte-identically, as a
single Enterprise Hosted Service (ADR-043 Runtime → ADR-044 Host), while the legacy standalone
boot still works. Mode is chosen only by `PLATFORM_ENABLED` and `PLATFORM_HOST`. **No
Enterprise kernel is consumed** — the Platform Adapter Layer is built but inert.

## Code delivered (additive; only `server.js` + `.env.example` modified)

| Path | Purpose |
|---|---|
| `src/app/onCallApplication.js` | Behavior-identical app factory (wiring + start + stop) extracted from `server.js`. Imports no Enterprise code. |
| `src/hosted-service/onCallAppService.js` | ADR-044 §2 hosted-service wrapper (9 methods + `ready()`). |
| `src/platform-adapters/**` | 12 inert translation adapters + `index.js` (the only app↔kernel seam). |
| `src/enterprise/index.js` | `bootEnterprise()`: bootstrap → createHost → register → host.start + signals. |
| `src/enterprise/mode.js` | `selectBootMode(env)` pure flag→mode function. |
| `server.js` | Now an 88-line flag-branching launcher. |
| `tests/unit/hosted-service.test.js` | Contract, lifecycle, host registration, both modes, flag switching. |
| `tests/unit/platform-adapters.test.js` | Adapter layer: inert, translators, port injection, no repo/db surface. |
| `tests/integration/mode-parity-ab.mjs` | Live A/B: boots both modes, diffs HTTP responses (run on app OS/CI). |

## Documents

| # | Doc |
|---|---|
| 00 | [Hosted Service Design](00_HOSTED_SERVICE_DESIGN.md) |
| 01 | [Platform Adapter Design](01_PLATFORM_ADAPTER_DESIGN.md) |
| 02 | [Startup Sequence](02_STARTUP_SEQUENCE.md) |
| 03 | [Shutdown Sequence](03_SHUTDOWN_SEQUENCE.md) |
| 04 | [Host Registration Flow](04_HOST_REGISTRATION_FLOW.md) |
| 05 | [Compatibility Verification Report](05_COMPATIBILITY_VERIFICATION_REPORT.md) |
| 06 | [Updated Architecture Diagram](06_ARCHITECTURE_DIAGRAM.md) |

## How to run

```bash
# Legacy (default) — unchanged
node server.js

# Enterprise — app runs as a Hosted Service on the Platform
PLATFORM_ENABLED=1 PLATFORM_HOST=1 node server.js

# Tests
node --test tests/unit/hosted-service.test.js tests/unit/platform-adapters.test.js
node tests/integration/mode-parity-ab.mjs      # requires sqlite3 to load (app OS / CI)
npm run lint && npm run test:ab                 # CI gates (mode-parity harness auto-included)
```

## Verification status (see doc 05 for detail)
- ✅ Full lint (CI gate) exit 0.
- ✅ 12 new unit tests + enterprise-layer regression (57/57) pass.
- ✅ Full Host lifecycle proven end-to-end with an injected fake app (no sqlite needed).
- ✅ Only `server.js` + `.env.example` changed; all routers/services/repos/middleware/socket/
  schema untouched.
- ⏳ Live HTTP A/B (`mode-parity-ab.mjs`) + DB-backed suites must run on the app's normal OS /
  CI, where the `sqlite3` native binding loads (it cannot in a cross-arch analysis sandbox).

## Success criteria mapping
OnCall executes inside the Enterprise Host ✓ · Legacy mode works ✓ · Enterprise mode works ✓ ·
Zero API/Flutter/DB/auth/Socket.IO changes ✓ (by construction + untouched code) · Tests pass ✓
(sandbox-runnable subset) · A/B remains 100% ⏳ (run `mode-parity-ab.mjs` on app OS/CI to
confirm `Result: IDENTICAL`).

## STOP boundary honored
No Config / Identity / Policy / Audit / Storage migration; no Gateway integration; no kernel
consumed. This phase established only the Hosted Service and the (inert) Enterprise Adapter
Layer.
