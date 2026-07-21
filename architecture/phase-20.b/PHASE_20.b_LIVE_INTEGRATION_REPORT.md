# Phase 20.b — Identity Shadow Live Integration & CI A/B Verification — Report

## Executive Summary

The Identity Shadow is now integrated into the **real request path** — HTTP (an observer middleware)
and Socket (the handshake) — as a strictly **observational** component, and the CI pipeline that
produces **ADR-047 Gate B2** evidence exists. The shadow runs comparisons on live requests **only
when `PLATFORM_IDENTITY=1 && SHADOW_IDENTITY=1`**; with the flags OFF (default) the integration code
is **never required and never mounted**, so production is byte-identical. The shadow **never mutates
`req`/`res`, never touches the socket decision, never throws, and returns nothing** — legacy
identity stays authoritative. Nothing was promoted, no flag was enabled, no legacy code removed.

**Honest evidence status (mission CI Rules — no fabrication):** the environment-independent evidence
is measured and green here (pure token/claims parity **100%**, socket-decision A/B **identical**,
middleware observation proven). The server-dependent evidence (HTTP A/B, DB refresh/revocation,
cross-replica revocation, staged rollback) **requires sqlite + a live server / multi-replica** and is
**authored + CI-wired** but reported **UNAVAILABLE-IN-THIS-ENV** — it must be produced by CI/staging.
The Gate B2 verdict is therefore **INCOMPLETE (not met)** — correctly refusing to declare parity that
hasn't been measured.

**Verification:** ESLint PASS · Architecture **R1–R8 PASS (0 violations)** · unit regression
**901/901** · other shadows (config/obs/jobs/scheduler) unchanged · zero-impact-when-OFF proven.

## 1. Live integration (observational; default OFF)

| Surface | Integration | Gate |
|---|---|---|
| HTTP | `src/middleware/identityShadowMiddleware.js` — `mountIdentityShadow(app, services)` mounts an observer before routes; runs `shadowOtpRequired` on every request + `shadowVerify`/`shadowResolvePrincipal`/`shadowIsAdmin` when a token is present | mounted only when `PLATFORM_IDENTITY=1 && SHADOW_IDENTITY=1` (lazy-required; skipped when OFF) |
| Socket | `src/socket.js` handshake — after the authoritative `verifyJWT`, an `if (svc.identityShadow)` block observes `shadowVerify`/`shadowResolvePrincipal` | branch present only when the shadow is composed (flags ON); `undefined` when OFF ⇒ skipped |
| Middleware | the observer sees every request's `Authorization`/`x-session-token` header | reuses the SAME shadow instance across HTTP + socket (`services.identityShadow`) |

**Execution model realised:** `verifyJWT (legacy, authoritative) → shadow compare → metrics → legacy
result returned/used`. The shadow returns the legacy value and is wrapped in try/catch at every call
site, so it cannot influence the request or the handshake.

## 2. Zero production impact (proven)

- With default env (no flags), the app factory's gated block evaluates false → `identityShadowMiddleware`
  is **never required** (verified: not in module cache) and **not mounted**; `socket.js`'s branch is
  skipped (`svc.identityShadow` undefined). Production path is byte-identical.
- Unit tests prove the observer **calls `next()`**, **never sets `req.user`**, **never touches `res`**,
  and **never throws** (even on garbage tokens).
- `PLATFORM_IDENTITY` / `SHADOW_IDENTITY` / `IDENTITY_AUTHORITATIVE` all default **OFF**. Flutter
  requires zero changes; API unchanged.

## 3. CI A/B suite (the ADR-047 verification pipeline)

| Artifact | Purpose | Runs |
|---|---|---|
| `tests/integration/identity-http-ab.mjs` | Boots the server twice (shadow OFF vs ON); asserts byte-identical identity-endpoint responses (status+body+contract headers) | **CI** (sqlite); auto-included by `scripts/run-ab.mjs` (`ab-compat`) |
| `tests/integration/identity-socket-ab.mjs` | Socket handshake decision A/B (OFF vs ON) — pure `verifyJWT`, environment-independent | **here + CI** — measured **IDENTICAL** |
| `scripts/identity-parity-report.mjs` (`npm run identity:parity-report`) | Emits measured JSON parity/mismatch/latency/coverage → `evidence/identity-parity-report.json` | **here + CI** — 100% pure surface |
| `scripts/identity-gate-b2.mjs` (`npm run identity:gate-b2`) | Aggregates the ADR-047 Gate B2 criteria; marks each PASS/UNAVAILABLE by actual measurement | **here + CI** |

## 4. Parity rules covered

Byte-identical comparison implemented for: JWT header (alg/typ), JWT payload/claims, verify decision,
issue claims, authorization (admin), OTP decision, current principal, socket decision — **measured
100% on the pure surface**. Refresh tokens, repository reads, session/device persistence, and full
HTTP status/headers/body parity are **wired** (categories + HTTP A/B) and produced **in CI** (need a
DB/live server).

## 5. Gate B2 evidence (measured; honest gaps)

Written to `architecture/phase-20.b/evidence/`:
- `identity-parity-report.json` — overall **100%**, 25 comparisons, 0 mismatch, 0 failure; jwt/authz/otp 100%; latency + coverage recorded.
- `gate-b2-evidence.json` — per-criterion:
  - **B2.1 token/claims byte-identical:** pure surface **PASS**; HTTP A/B + DB refresh/revocation **UNAVAILABLE-IN-THIS-ENV** (CI command recorded).
  - **B2.2 cross-replica revocation timing:** **UNAVAILABLE** (needs multi-replica + Redis; staging).
  - **B2.3 staged rollback, no re-auth:** **UNAVAILABLE** (flag-only rollback; verify in staging soak).
  - **B2.socket decision parity:** **PASS** (measured).
  - **Verdict: INCOMPLETE — Gate B2 NOT met.** HTTP/DB/cross-replica/rollback evidence must be produced in CI/staging. **Not promoting.**

No fabrication, no estimation, no simulated production evidence (per the mission's CI Rules).

## 6. Validation

| Check | Result |
|---|---|
| Architecture R1–R8 (dependency rule, layer isolation, cycles) | ✅ PASS (0 violations) |
| ESLint (project scope) | ✅ PASS |
| Unit regression (incl. 4 new middleware tests) | ✅ 901/901 |
| Zero-impact when OFF (not required/mounted; socket branch skipped) | ✅ proven |
| Shadow isolation (returns legacy only, never throws, never mutates req/res) | ✅ unit-proven |
| Other shadows + config authoritative unchanged | ✅ `verify:shadow` PASS |
| Legacy authoritative (`middleware/auth.js`/OTP/gateways) unchanged | ✅ no edits |
| HTTP A/B + DB/refresh + security suites | ⏳ CI (sqlite) |

## 7. Success criteria — status

- ✅ Identity Shadow executes on every request **when enabled** (HTTP observer + socket hook).
- ✅ Legacy Identity remains authoritative; ✅ no production behavior change (OFF ⇒ byte-identical).
- ✅ CI **can** produce ADR-047 Gate B2 evidence (suite authored + wired; generators run).
- ✅ Ready for **Phase 20.c (Feature Flag validation)** — pending the CI/staging Gate B2 evidence.

## 8. Scope boundary (honest)

Measured here: socket-decision A/B, pure token/claims parity, middleware isolation. **Produced in
CI/staging (not here):** HTTP response A/B, DB refresh/revocation parity, cross-replica revocation
timing, staged-rollback proof. Until those are green in CI, **Gate B2 is INCOMPLETE** and no flag
flip / promotion may occur. `IDENTITY_AUTHORITATIVE` is **not introduced** in this phase.

## Host actions

Commit on the host. Run the CI `ab-compat` job (now includes `identity-http-ab.mjs` +
`identity-socket-ab.mjs`) and `npm run identity:gate-b2` in CI to populate the server-dependent Gate
B2 evidence, then proceed to Phase 20.c.
