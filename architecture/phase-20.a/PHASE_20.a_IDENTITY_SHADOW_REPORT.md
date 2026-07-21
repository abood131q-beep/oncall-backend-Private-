# Phase 20.a — Identity Shadow Implementation — Report

## Executive Summary

The **Identity Shadow** now exists and observes identity behavior **without affecting production**.
The legacy identity path (`middleware/auth.js`, OTP, token gateway, repository) remains the **sole
authoritative** implementation. The shadow runs each identity operation through both the legacy
authority and the Consolidated Enterprise Identity Kernel path (kernel token adapter as a
**pass-through** to the same certified primitives; kernel domain reimplementation for
authorization/principal), compares the results, records every difference with full metadata, and
**returns the legacy result only**. It reaches **100% parity** on the environment-independent
("pure") surface — JWT verify/issue/header, admin resolution, OTP-required, principal resolution —
and is **inert when disabled**. No cutover, no flag flip, no authoritative promotion, no legacy
removal. This satisfies ADR-049 §7 step "Shadow" and produces the parity evidence needed to open
Identity A/B (Gate B2, ADR-047).

**Verification:** ESLint PASS · Architecture **R1–R8 PASS (0 violations)** · `verify:shadow`
(config/observability/jobs/scheduler) **unchanged/PASS** · new `verify:identity-shadow` **PASS
(100% parity, 0 mismatch, 0 failure)** · unit regression **884/884** (16 identity tests) · shadow
**off the production request path** (scan confirms no prod module imports it).

## 1. What was built (additive; legacy untouched)

| File | Role |
|---|---|
| `src/platform-adapters/identity/legacySource.js` | Read-only view over the LEGACY authoritative primitives (the answer of record) |
| `src/platform-adapters/identity/kernelSource.js` | The kernel-path candidate (token pass-through + domain authz/principal) |
| `src/platform-adapters/identity/shadow.js` | The shadow verifier: compare → record → **return legacy only**; per-category + overall metrics |
| `src/enterprise/identityShadow.js` | Flag selection (`PLATFORM_IDENTITY`/`SHADOW_IDENTITY`, default OFF) + seed/attach |
| `src/infrastructure/identity/tokenAdapter.js`, `otpAdapter.js` | Now **pass-through** to injected legacy primitives (inert `NotWired` when unwired) |
| `src/domain/identity/kernel/policies.js` | Authorization reimplementation mirroring legacy exactly (non-authoritative) |
| `scripts/verify-identity-shadow.mjs` (+ `npm run verify:identity-shadow`) | sqlite-free parity gate |
| `tests/unit/identityShadow.test.js` | 6 shadow tests (return-legacy, 100% parity, never-throws, mismatch metadata, inert, metrics) |

The 19.4 skeleton's inert posture is preserved for anything **not** wired (adapters still throw
`IdentityKernelNotWired` when no legacy primitive is injected).

## 2. Execution model (matches the mission)

```
  request/operation
        │
        ▼
   Legacy Identity  ── authoritative result ──┐
        │                                      │
        ▼                                      ▼
   Shadow Identity  ──►  Compare (deepEqual) ──► Record differences ──► RETURN LEGACY RESULT ONLY
        │                                                                     ▲
   (kernel path: token pass-through + domain authz)                          │
   never authoritative · never throws to caller · disabled ⇒ no comparison ──┘
```

Hard guarantees (unit-proven): every `shadow*` method returns the **legacy** value; a kernel
exception is captured as a **verification failure** and never propagates; disabled ⇒ zero
comparisons; token values are **redacted** in records.

## 3. Responsibilities compared

| Responsibility | Category | Verified here? |
|---|---|---|
| JWT verify (decision + payload) | jwt | ✅ 100% |
| JWT issue → claims (payload/exp/issuer/audience shape) | jwt | ✅ 100% |
| JWT signature algorithm (header alg/typ) | jwt | ✅ 100% |
| Authorization / Admin resolution | authz | ✅ 100% |
| OTP requirement | otp | ✅ 100% |
| Principal / roles / claims resolution | principal | ✅ 100% |
| Refresh issue/verify/revoke, Repository reads | refresh/repository | declared; **CI/DB-only** |
| Session/Device identity, Socket authentication | socket | declared; **CI/live-server-only** |

The DB- and request-bound comparisons are wired into the shadow's category model but are exercised
only where a database / live server exists (CI) — exactly as `verify-shadow.mjs` covers the pure
surface for the other kernels and the `*-ab.mjs` harnesses cover HTTP in CI.

## 4. Difference reporting

Every mismatch/failure record carries: `requestId`, `operation`, `category`, `legacy`, `kernel`,
`legacyType`/`kernelType`, `differenceCategory` (`value-mismatch` | `kernel-exception`),
`rootCauseHypothesis`, `severity` (jwt/authz = **critical**, otp/refresh = high, else medium), and
`at` (timestamp). Token-bearing values are redacted. Nothing is ignored (kernel exceptions are
recorded as verification failures, not swallowed silently).

## 5. Metrics (available)

`report()` exposes: overall parity %, mismatch counts, verification failures, **jwtParityPct**,
**authorizationParityPct**, **otpParityPct**, **repositoryParityPct**, **socketParityPct**, per-
category tallies, execution latency (avg/max), confidenceLevel, coveragePct, and the mismatch log.
Current pure-surface run: **overall 100%, jwt 100%, authz 100%, otp 100%, 25 comparisons, 0
mismatch, 0 failure.**

## 6. Validation

| Check | Result |
|---|---|
| Architecture R1–R8 (dependency rule, layer isolation, no cycles) | ✅ PASS (0 violations) |
| Port integrity (`assertPorts`) / provider integrity | ✅ (19.4 tests + new tests) |
| Shadow isolation (returns legacy only, never throws) | ✅ unit-proven |
| Zero production impact (shadow not imported by any prod path) | ✅ scan: NONE |
| Security (kernel non-authoritative; tokens redacted; JWT crypto unchanged) | ✅ |
| `verify:shadow` (other 4 kernels) unchanged | ✅ PASS |
| `verify:identity-shadow` | ✅ PASS |
| Unit regression | ✅ 884/884 |
| Legacy authoritative & unchanged (`middleware/auth.js`, otpService, gateways) | ✅ no edits to those files |
| DB/HTTP/socket/security integration + Identity HTTP A/B | ⏳ CI (next phase; sqlite/server unavailable here) |

## 7. Success criteria — met

- ✅ Legacy Identity remains authoritative (no edits to `middleware/auth.js`/OTP/gateways).
- ✅ Shadow executes for every (pure) identity operation and is structured for the DB/socket ones.
- ✅ Production behavior unchanged; **Flutter zero changes; API byte-identical** (shadow off the
  request path, returns legacy only).
- ✅ Every comparison is recorded (with full metadata + severity + root-cause hypothesis).
- ✅ Parity metrics are available (overall + per-category).
- ✅ The project is ready for Identity A/B verification (Phase 20.c) — the parity seam + evidence now
  exist.

## 8. Scope boundary (honest)

This phase implemented the shadow **mechanism** and proved parity on the pure surface. It did **not**
hook the shadow into the live HTTP/socket request handlers, and did **not** run the HTTP-level
Identity A/B — both require a running server + sqlite (unavailable in this sandbox) and belong to
Phase 20.c under ADR-047 Gate B2. No flag was flipped; nothing became authoritative; no legacy code
was removed. `PLATFORM_IDENTITY`/`SHADOW_IDENTITY` default OFF.

## Host actions

Commit on the host (sandbox `.git/index.lock` FUSE limit). Next: wire the shadow into the enterprise
boot's out-of-band pass + add the HTTP/socket Identity A/B harness in CI (20.b/20.c), then proceed
per ADR-049 §7 (Flag → Soak → Authoritative) with Gate B2 evidence.
