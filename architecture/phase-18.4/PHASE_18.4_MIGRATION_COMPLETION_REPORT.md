# Phase 18.4 — Complete Runtime Configuration Migration — Completion Report

## Executive Summary

The Runtime Configuration Read Facade migration (begun in Phase 18.3) is **complete**. Every runtime
consumer of `src/config/env.js` has been migrated to the facade (`config.get` / `config.all`). The
**R8 legacy allowlist is now empty** — the only modules permitted to read `env.js` directly are the
three documented architectural exemptions (the source, the facade, and the Configuration shadow's
legacy source). All architecture gates pass with the allowlist at zero, and every runnable
verification is green with **zero production behavior change, zero API change, zero JWT/auth change,
and zero routing change**. This phase did **not** promote the Configuration kernel; it satisfies the
final structural prerequisite for ADR-048.

The migration used the lowest-risk faithful pattern: each consumer's `const { X } = require('../config/env')`
was replaced by `const config = require('../config')` plus `const X = config.get('X')` — preserving
every downstream usage site, guard clause, throw, and typed value unchanged. Behavioral equivalence
between the facade and direct `env.js` was proven empirically (including the fail-fast path).

## Files Changed

**Consumers migrated (10):**

| File | Layer | Keys | Migration |
|---|---|---|---|
| `src/middleware/auth.js` | middleware (security) | JWT_SECRET, ADMIN_PHONES | facade rebind; 3 usage sites unchanged |
| `src/app/onCallApplication.js` | app factory | ADMIN_PHONES, PORT, SOCKET_CORS_ORIGIN | facade rebind + inline `require('../config/env')`→`config.all()` (identity router) |
| `src/presentation/api/adminRoutes.js` | presentation | NODE_ENV, PORT, TZ | facade rebind |
| `src/presentation/api/commerceRoutes.js` | presentation | PAYMENT_ENABLED | facade rebind |
| `src/routes/auth.js` | routes | REQUIRE_OTP, SMS_PROVIDER | facade rebind; 5 usage sites unchanged |
| `src/routes/payment.js` | routes | PAYMENT_ENABLED | facade rebind |
| `src/routes/admin.js` | routes | NODE_ENV, PORT, TZ | facade rebind |
| `src/services/smsService.js` | service | SMS_PROVIDER, SMS_API_KEY, SMS_FROM, SMS_ACCOUNT_SID, IS_PRODUCTION | facade rebind; all guard/throw sites unchanged |
| `src/services/notificationService.js` | service | FIREBASE_SERVICE_ACCOUNT, FIREBASE_PROJECT_ID | facade rebind |
| `server.js` | bootstrap | (side-effect load) | `require('./src/config/env')`→`require('./src/config')` (facade re-triggers env fail-fast) |

**Governance changed (1):** `architecture/compliance/verify-architecture.mjs` — R8 `LEGACY_ALLOWLIST`
emptied (`new Set([])`). EXEMPT set unchanged.

No application logic, response shape, route, token, schema, or public API was modified.

## Remaining `env.js` Consumers

Direct importers of `src/config/env.js` remaining — **exactly the three approved exemptions, nothing else**:

```
src/config/env.js                                   the source module itself
src/config/index.js                                 the facade — the ONE approved backing point
src/platform-adapters/configuration/legacySource.js the Configuration shadow's legacy source (by design)
```

Verified by scan: `grep -rn "require('…config/env')" src/ server.js` returns **no** matches outside
those three. **Zero runtime consumers remain.**

## R8 Status

**COMPLETE — allowlist = 0.** R8 (config-read-seam) now enforces the invariant absolutely: any module
other than the three EXEMPT files that imports `config/env` is a **MAJOR** violation and fails CI. The
ratchet has reached its terminal state; it can only remain at zero (the allowlist cannot grow). The
enforcement was re-proven this phase (gate PASS at empty allowlist; the 18.3 synthetic-violation test
already demonstrated a new direct importer is caught).

## Verification Results

| Gate | Where | Result |
|---|---|---|
| ESLint (`--max-warnings 0`, incl. prettier rule) — all 10 migrated files | here | ✅ PASS |
| Architecture compliance **R1–R8**, allowlist=0 | here | ✅ PASS (0 violations) |
| `verify:shadow` (4 shadows) | here | ✅ PASS — parity 100%, coverage 100%, 0 mismatches; inert when flags OFF |
| Facade unit test (`configFacade.test.js`) | here | ✅ 7/7 |
| Unit regression (enterprise + shadow + host + facade) | here | ✅ 870/870 |
| Module load-smoke (auth, sms, notification, otp, places, setup) | here | ✅ all load; facade returns identical values |
| Fail-fast equivalence (facade ≡ direct env.js, JWT_SECRET absent) | here | ✅ both exit 1, identical message |
| Repository/DB-backed unit + integration + `ab-compat` A/B | CI (sqlite) | ⏳ runs in CI |
| PostgreSQL cross-engine A/B | CI (Docker) | ⏳ runs in CI |

**Behavioral-equivalence proof (empirical):** with a `.env` present, `require('./src/config/env')`
and `require('./src/config')` both load successfully (exit 0); with no `.env` and `JWT_SECRET` unset,
**both** abort with exit 1 and the identical `FATAL: JWT_SECRET is required` message. The facade is a
pure synchronous pass-through of `env.js`, so migrated consumers receive byte-identical typed values.

## Regression Report

No regression in any protected surface:

- **JWT / Authentication:** `auth.js` keeps the same `JWT_SECRET`/`ADMIN_PHONES` values (now via
  `config.get`); the HMAC sign/verify sites and admin-phone check are byte-unchanged. Token format
  and verification are untouched.
- **Configuration:** every value is the exact `env.js`-computed typed value (facade returns
  `env[key]` by reference); `verify:shadow` config parity remains 100%.
- **Routing:** route registration and the identity-router wiring are unchanged (the router now
  receives `config.all()`, a plain object with the same `REQUIRE_OTP`/`SMS_PROVIDER` values it read
  before).
- **Startup:** `server.js` still loads config first and fail-fasts identically; boot-order unchanged.
- **Flutter compatibility:** no route, response body, header, or token change → no client impact.

Per the mission, any regression in JWT/auth/config/routing/startup/Flutter would have stopped the
phase. None occurred; no workarounds were applied.

## Architecture Impact

- **Single seam achieved app-wide:** 100% of runtime configuration reads now flow through
  `src/config/index.js`. `env.js` is reachable only through the facade (plus the two by-design
  exemptions). This is the structural property ADR-048 requires.
- **R8 terminal:** the config-read-seam invariant is now absolute and machine-enforced across all of
  `src/` + `server.js`.
- **No new abstractions, no layering change, no cycles** (R6 PASS). The facade still depends only on
  `env.js`.

## Performance Impact

Negligible/none. `config.get(key)` is a single `hasOwnProperty` check plus a property read, executed
at module-load time (same point the previous destructuring ran). Hot paths that read a config value
(e.g. `auth.js` HMAC) use module-level constants exactly as before — no added per-request work. No
measurable change to startup or request latency.

## Promotion Readiness Assessment — ADR-048

**Structural prerequisite: SATISFIED.** The blocker from the Phase 18.2 report — "no runtime
config-read seam; consumers bind `env.js` at import" — is fully resolved. Every consumer now reads
through the facade, so ADR-048 can re-point the backing (env → Configuration-kernel validated
snapshot, with mandatory `env.js` fallback) **in one file** (`src/config/index.js`) with **no further
consumer changes**.

**Remaining prerequisites before flipping `CONFIG_AUTHORITATIVE` (unchanged from P1-5 §4 — these are
promotion-execution items, not structural blockers):**

1. **Synchronous kernel snapshot at facade load.** Because config is read at module-init time (before
   the async platform boots), ADR-048 must make the kernel's validated snapshot available
   **synchronously** inside the facade (seed from defaults at load) — with `env.js` as the mandatory
   fallback. This is a facade-internal change (single file); it is *achievable* now precisely because
   the seam exists. **It is the one real engineering task ADR-048 must still do**, and it must be
   built and A/B-proven before promotion — do not assume it is free.
2. **Authoritative A/B harness** `config-authoritative-ab.mjs` (`CONFIG_AUTHORITATIVE=0` vs `=1`,
   byte-identical HTTP + identical startup config) wired into the CI `ab-compat` gate.
3. **Production soak** of the config shadow with zero drift (operational time).
4. **ADR-048** authored (citing ADR-046/047, attaching soak + A/B evidence) with Owner sign-off.

**Assessment:** The project is **structurally ready** for ADR-048 — the migration this phase
completes was the last *architectural* prerequisite. It is **not yet operationally cleared to
promote**: items 1–4 remain, and item 1 (synchronous kernel snapshot + fallback) is genuine code that
must be implemented and proven, not a formality. Per the mission's standard, **do not recommend
flipping `CONFIG_AUTHORITATIVE` until items 1–4 are objectively satisfied.** The Configuration kernel
remains NON-authoritative; nothing in this phase changed that.

## Sandbox Note (host action required)

Git commit is not possible from this sandbox (`.git/index.lock`, FUSE `Operation not permitted`), so
these changes must be committed host-side. Also delete the inert 18.3 test artifact
`src/services/__ratchet_probe.js` (`git clean -f`) — it contains no `config/env` import and does not
affect any gate, but it is not a real source file.

## Recommendation

Merge Phase 18.4. The runtime configuration migration is complete and R8 is terminal. Proceed to
ADR-048 **execution** by (1) implementing the synchronous kernel-snapshot backing inside the facade
with mandatory env fallback, (2) adding the authoritative A/B harness, (3) running the zero-drift
soak, and (4) authoring ADR-048 — then flip `CONFIG_AUTHORITATIVE` behind the flag with instant
rollback.
