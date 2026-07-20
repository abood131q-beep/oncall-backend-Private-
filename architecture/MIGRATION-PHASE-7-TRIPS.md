# Enterprise Architecture Migration — Phase 7 Record (Trips Cutover)

**Pattern:** Strangler Fig · **Authority:** G0.0 · ADR-002…015 · **Date:** 2026-07-20
**Status:** Cutover implemented and A/B-proven (31/31, full lifecycle). Legacy retained behind `TRIPS_LEGACY=1`.

---

## 1. Migration Report (summary)

The **Trips bounded context** — the platform's largest and most complex domain (legacy
`src/routes/taxi.js`, ~697 lines) — is migrated into the ADR-005 layered architecture using the
proven Strangler recipe. The new router is default; the legacy taxi router is the instant,
byte-identical rollback via `TRIPS_LEGACY=1`. Runtime behavior is unchanged; all 16 public
endpoints are frozen and proven byte-identical, **including the full ride lifecycle** (request →
accept → arrive → in_progress → live-location → complete-with-payment → rate → rate-passenger →
cancel).

**Design principle — reuse heavy integrations, migrate the decisions.** The Domain owns the state
machine and authorization (Assignment / Acceptance / Cancellation / Completion / StateTransition
policies + fare/distance settlement). The heavy legacy services are **reused via Infrastructure
gateways, never reimplemented**: the driver **matcher** (assignment + 30s timers), the **payment**
service (inside the serialized C-1 transaction), **Socket.IO** trip events, and **push**
notifications. This keeps the migration behavior-preserving while confining the layering.

**Scope migrated:** creation, acceptance, assignment/reassignment, reject, driver/requests/passenger
lists, full status lifecycle, cancellation, completion (payment reused), ratings (both directions),
HTTP location update + snapshot, single-trip read, admin delete-all, plus existing trip events and
notifications.

**NOT migrated (reused / co-located):** Wallet & Payments (reused via `completionGateway`, gated on
ADR-001), Fleet (`GET /taxis`) and Maps/Places (`GET /places/*`) are co-located non-Trips endpoints
kept byte-identical as thin reused passthroughs, pending their own Fleet/Maps phases. AI untouched.

## 2. Files Created (14)

**Domain (pure):** `src/domain/trips/tripValues.js` · `tripPolicies.js` · `Trip.js`
**Application:** `src/application/trips/ports.js` · `commands.js` · `useCases.js` · `index.js`
**Infrastructure:** `src/infrastructure/repositories/tripRepositoryAdapter.js` ·
`src/infrastructure/gateways/tripGateways.js` · `tripCoLocatedGateways.js`
**Presentation:** `src/presentation/api/tripsController.js` · `tripsRoutes.js`
**Tests:** `tests/unit/trips.test.js` · `tests/integration/trips-ab.mjs`

## 3. Files Modified (1)

`server.js` — a single guarded cutover block: the new Trips router is default; `TRIPS_LEGACY=1`
restores the legacy taxi router. No other runtime code changed.

## 4. Mounted Components (carrying traffic)

`tripsRoutes.js` → `tripsController.js` → `src/application/trips/*` → `src/domain/trips/*` → ports →
`tripRepositoryAdapter` + `tripGateways` (driver/matching/completion/event/fare/location) +
`tripCoLocatedGateways` (fleet/places). Reuses `TripRepository`, `driverMatcher`, payment service,
`io`, `notifService`/`NotificationRepository`, `fareCalculator`, and the serialized `dbTransaction`.

## 5. Legacy Components Remaining

`src/routes/taxi.js` — **unchanged this phase, unmounted by default.** Provably identical rollback
target (the A/B harness executes it as the "legacy" arm). Dead code pending later retirement.

## 6. Security Report (ADR-007)

| Control | Status | Evidence |
|---|---|---|
| JWT authentication | ✅ preserved | `authenticate*` on every route; A/B `*:noauth → 401` |
| Passenger authorization | ✅ | `authenticatePassenger` (request/rate/passenger-list); A/B parity |
| Driver authorization | ✅ | `authenticateDriver` (reject/lists/rate-passenger/location) + assigned-driver domain gates |
| RBAC (admin) | ✅ | `authenticateAdmin` on delete-all; A/B `deleteall:noauth → 403` |
| Ownership / IDOR | ✅ in Domain | `canAccessTrip` (get/location → `get:stranger 403`), rating ownership (`rate:stranger 403`), cancel ownership |
| State-machine integrity | ✅ | atomic `acceptByDriver`, driver-only transitions, cancellable-state guard |
| Rate limiting | ✅ unchanged | global limiter untouched |
| No security regression | ✅ | 31/31 A/B incl. every auth/ownership/state scenario |

## 7. Architecture Compliance Report

Verifier: **PASS, 0 violations**, now scanning **75 enterprise-layer files** across seven contexts.
Rules R1–R7 green: no framework/SQL/Socket.IO in Domain/Application, controller imports no
Domain/Infra, no cycles, ports asserted. The CI Architecture Gate enforces this on every PR/push.

## 8. ADR Compliance Addendum

- **ADR-002:** Trip aggregate + TripStatus/TripId/Pickup/Destination VOs + Assignment/Acceptance/
  Cancellation/Completion/StateTransition policies (pure). → **Impl**
- **ADR-003:** Arabic frozen default (byte-identical); English additive. → **Impl**
- **ADR-004:** completion inside the serialized transaction boundary (C-1 safe); read models
  projected via `formatTrip`. → **Part** (Postgres cutover Planned)
- **ADR-005:** five layers, ports/fail-fast, one transaction boundary, gates before domain. → **Impl**
- **ADR-006:** frozen REST/JSON contract + existing Socket.IO trip events preserved; A/B 31/31. → **Part**
- **ADR-007:** §6 above. → **Impl**
- **ADR-008:** layout + DI composition root. → **Impl**
- **ADR-009/010:** unchanged. → **Part**
- **ADR-011 (AI):** N/A · **ADR-012/013/014/015:** governance synced; roadmap advanced; manifesto upheld. → **Impl**

## 9. Updated Traceability Matrix

`architecture/compliance/MATRIX.md` — Trips row upgraded to `Impl` for ADR-002/003/005/007/008.
Fully ADR-005-compliant contexts now **7/11** (Identity, Users, Localization, Drivers, Scooters,
Notifications, Trips).

## 10. Updated Evidence Mapping

`architecture/compliance/EVIDENCE.md` — Trips rows added (ADR-002/003/005/006/007) pointing at the
new sources, `tests/unit/trips.test.js`, and `tests/integration/trips-ab.mjs` (31/31).

## 11. Updated Repository Readiness Report

`architecture/compliance/REPOSITORY-READINESS.md` — Trips complete; next context under the enforced
gate; Wallet/Payments remain last, gated on ADR-001.

## 12. Test Results (executed)

- **Unit:** 127/127 pass (added the Trips slice; coverage increased).
- **A/B compatibility:** Trips **31/31 byte-identical** — full lifecycle exercised with a real,
  admin-approved driver token (accept 200 → arrived 200 → in_progress 200 → location 200 →
  **completed 200 with payment settled** → rate 200 → rate-passenger 200 → cancel-completed 400),
  plus validation (400s), auth (401/403), IDOR (`get:stranger 403`, `rate:stranger 403`), duplicate
  rating 409, admin delete-all, and co-located `/taxis` + `/places`.
- **Regression (no existing test failed):** Identity 35 · Users 17 · Drivers 14 · Scooters 24 ·
  Notifications 21 — all still byte-identical.
- **Architecture:** verifier PASS (75 files). **Lint + Format:** clean (whole tree).

## 13. Rollback Procedure

`TRIPS_LEGACY=1` + restart → legacy `src/routes/taxi.js` serves all trip traffic. Rollback path is
live-proven (the harness's legacy arm is exactly rollback mode). No data migration — same `trips`
table via the same repositories/services. Full code rollback: revert the one `server.js` block.

## 14. Technical Debt

1. `src/routes/taxi.js` dead code — retire after a production soak.
2. `/taxis` (Fleet) and `/places/*` (Maps) are co-located passthroughs — extract into their own
   contexts in later phases.
3. Wallet/Payments reused via `completionGateway`; formalize when the Commerce phase lands (ADR-001).
4. Socket.IO trip events remain in-process (single-instance) — Redis adapter is the platform-wide
   scale item (G0.0 G5), unchanged by this migration.

## 15. Architecture Drift Report

**Zero drift.** Verifier passes at 75 files with 0 violations; the CI gate blocks any regression. The
largest, most side-effect-heavy handler in the platform (status lifecycle with payment + socket +
push) now flows through clean layers with the decisions in the Domain and the integrations reused
behind ports — no boundary crossed by the new code (mechanically confirmed).

## 16. ADR Coverage Delta (this phase)

| ADR | Before (Trips) | After (Trips) |
|---|---|---|
| 002 Domain | Part | **Impl** |
| 003 Global | Plan | **Impl** |
| 005 App | Plan | **Impl** |
| 006 Integ | Plan | **Part** |
| 007 Sec | Part | **Impl** |
| 008 Tech | Part | **Impl** |
| 013/014/015 | Plan/Part | **Impl** |

Platform: fully ADR-005-compliant contexts **6 → 7 / 11**.

## 17. Phase 8 Readiness Assessment

**READY.** Trips is migrated, byte-compatible (31/31 full lifecycle), security-preserving,
verifier-clean, CI-gated, instantly reversible; governance artifacts synchronized. The remaining
legacy contexts are **Fleet**, **Wallet**, **Payments**, **AI**, and **Admin**. Recommended next:
**Admin** (large surface, RBAC already strong, no Commerce invariants) or **Fleet** (small; unblocks
extracting the co-located `/taxis`). **Wallet & Payments remain last, gated on the ADR-001 decision**
— Phase 7 deliberately reused (never migrated) the payment path to keep that gate intact. Phase 8
begins only under an approved bounded-context mandate + A/B plan.

---

*Migration executed under the Strangler Fig pattern. Every PASS is backed by an executed test or a
mechanical check. No legacy behavior changed; no new business feature added; public contracts frozen
and proven byte-identical across the full trip lifecycle; heavy integrations reused, not reimplemented.*
