# Enterprise Architecture Migration — Phase 1 Record

**Pattern:** Strangler Fig · **Governing ADRs:** G0.0, ADR-002…ADR-005
**Status:** Phase 1 executed · **Date:** 2026-07-18
**Prime rule honored:** the legacy system remains fully authoritative; zero behavior
changed; the platform is runnable at this exact commit state.

## 1. Migration Plan

| Phase | Scope | Cutover risk |
|---|---|---|
| **1 (this)** | Enterprise folder tree + complete Identity slice built in parallel (unmounted) + unit-proof | zero — no traffic touches new code |
| 2 | Mount identity router in place of legacy auth routes behind full live validation battery (auth changes require live proof); migrate `/auth/verify`, `/auth/is-admin` | low, reversible in one line |
| 3 | Delete legacy auth route bodies (delegate stubs only), begin next context (Users or Trips) by the same recipe | low |
| 4+ | Context-by-context: drivers → scooters → trips → wallet/payments (payments last, after ADR-001 decision) | per-context |

## 2. Folder Tree (created)

```
src/
  presentation/ {api, websocket, middleware, admin}
  application/  {identity, users, drivers, scooters, trips, wallet,
                 payments, notifications, fleet, ai, shared}
  domain/       {identity, users, drivers, scooters, trips, wallet,
                 payments, notifications, fleet, shared}
  infrastructure/ {database, repositories, gateways, mqtt, payment,
                   maps, notifications, logging, ai}
  shared/
  config/   (pre-existing: env.js, database.js, migrate.js — unchanged)
tests/      (pre-existing; + unit/identity.test.js)
```

39 directories; empty ones carry `.gitkeep`.

## 3. Files Created (Phase 1)

| Layer | File | Role |
|---|---|---|
| Domain | `src/domain/shared/Phone.js` | Phone value object (mirrors legacy rule exactly) |
| Domain | `src/domain/identity/loginPolicy.js` | pure business gates: passenger gate, driver approval gate (P6-06), driver refresh gate, admin rule, session payload builders |
| Application | `src/application/identity/ports.js` | capability contracts + fail-fast composition check |
| Application | `src/application/identity/commands.js` | 5 commands + input validation (typed rejections) |
| Application | `src/application/identity/useCases.js` | SendOtp · LoginPassenger (implicit register) · LoginDriver (implicit register) · RefreshSession (rotation + P6-06 revoke-on-block) · Logout / LogoutAll (authz policy) |
| Application | `src/application/identity/index.js` | composition entry |
| Infrastructure | `src/infrastructure/repositories/identityRepositoryAdapter.js` | wraps existing user/driver repos + login-log write |
| Infrastructure | `src/infrastructure/gateways/tokenGatewayAdapter.js` | wraps certified token primitives — **no crypto/session logic reimplemented** |
| Infrastructure | `src/infrastructure/gateways/otpGatewayAdapter.js` | wraps existing OTP service |
| Presentation | `src/presentation/api/identityController.js` | typed results → byte-identical legacy responses |
| Presentation | `src/presentation/api/identityRoutes.js` | router (same paths + limiter order) — **NOT mounted** |
| Tests | `tests/unit/identity.test.js` | 15 tests incl. security paths (rotation replay, suspended-driver refresh revocation) |

## 4. Files Moved

**None.** Strangler rule: nothing moves until the new branch carries traffic and the
old one is proven dead. All legacy folders remain in place and authoritative.

## 5. Files That Remain Temporarily (legacy, to be strangled per phase)

`src/routes/auth.js` (authoritative until Phase 2 cutover) · `src/routes/*.js` (per
later phases) · `src/middleware/auth.js` (its primitives are wrapped, not replaced —
extraction of token internals is a later, separately-validated step) ·
`src/services/otpService.js` (wrapped) · `src/repositories/*` (wrapped; become
infrastructure implementations progressively) · `src/utils/helpers.js#validatePhone`
(mirrored by the Phone VO; retired when last legacy route dies).

## 6. Risks

1. **Dual implementations during transition** — the slice mirrors the legacy routes;
   until cutover, a change to legacy auth must be mirrored (guarded by: the unit suite
   encodes the contract, and Phase 2 is scheduled close).
2. **Auth cutover is security-sensitive** — mitigated by keeping Phase 1 unmounted and
   gating Phase 2 on the live validation battery (platform rule: auth changes need
   live proof; this sandbox cannot run the live server).
3. **Pre-existing dirty working tree** — `server.js`, `src/routes/auth.js` and others
   carry uncommitted changes predating this migration; recommend committing a baseline
   before Phase 2 so cutover diffs are surgical.
4. **`/auth/verify` & `/auth/is-admin`** intentionally deferred (pure token
   introspection, frozen mobile contract — lowest-value, touchiest surface).

## 7. Compatibility Strategy

Response contract is **byte-frozen**: identical paths, status codes, JSON shapes, and
Arabic messages (encoded in `identityController.js` and asserted by tests). Rate-limit
middleware order preserved. DB access delegates to the same repositories/statements —
zero schema or query drift. Admin-no-refresh-token rule, implicit registration,
OTP-before-account-work ordering, and P6-06 revoke-on-blocked-refresh are each
explicitly encoded and unit-proven.

## 8. Rollback Strategy

Phase 1 is inherently rollback-free risk: new code is unmounted; deleting the new
directories restores the prior state exactly. Phase 2 cutover will be a single-line
mount swap in `server.js` — rollback = revert that line (legacy router remains in the
tree until Phase 3+). No data changes at any phase boundary.

## 9. Verification Checklist (evidence, this environment)

- [x] All new files pass syntax check (`node --check`, 11 files)
- [x] Full lint clean incl. new layers (`npm run lint`, 0 warnings)
- [x] Prettier clean (`format:check`: all files pass)
- [x] Legacy unit suite intact: 55/55 pass
- [x] New identity suite: 15/15 pass (total 70/70)
- [x] Dependency rules audited mechanically: domain/application contain no framework,
      storage, query text, or legacy-route imports; domain is pure
- [x] `server.js` and all legacy runtime files: zero edits in Phase 1 (pre-existing
      uncommitted changes predate this work and were left untouched)
- [x] All existing endpoints continue working: **guaranteed by construction** — no
      mounted surface changed; live-server smoke (`/health`, login flows) re-run at
      Phase 2 cutover on a host with the native runtime, per the standing battery
