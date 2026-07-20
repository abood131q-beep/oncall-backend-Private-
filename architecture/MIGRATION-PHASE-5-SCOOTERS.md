# Enterprise Architecture Migration — Phase 5 Record (Scooters Cutover)

**Pattern:** Strangler Fig · **Authority:** G0.0 · ADR-002…015 · **Date:** 2026-07-20
**Status:** Cutover implemented and A/B-proven (24/24). Legacy retained behind `SCOOTERS_LEGACY=1`.

---

## 1. Migration Report (summary)

The **Scooters bounded context** is migrated into the ADR-005 layered architecture beside the
legacy `src/routes/scooters.js`, using the proven Strangler recipe (Identity/Users/Drivers). The
new router is the default; the legacy router is the instant, byte-identical rollback via
`SCOOTERS_LEGACY=1`. Runtime behavior is unchanged; the public HTTP contract is frozen and proven
byte-identical across all 11 legacy endpoints. Only existing capabilities were migrated — no new
business feature was invented.

**Scope migrated (existing capabilities only):** discovery (`GET /scooters`), details
(`GET /scooters/:id`), unlock (`POST /scooter/unlock`), end-ride (`POST /scooter/end-ride`),
active-ride status (`GET /scooter/active/:phone`), ride history (`GET /scooter/history/:phone`),
admin add/delete (`POST`/`DELETE /admin/scooters[/:id]`), admin reset (`POST /scooters/reset`),
and the two deprecated 410 shims (`/scooter/rent`, `/scooter/return`).

**Explicitly NOT migrated / not present in legacy:** Reservation, Firmware, Diagnostics, and live
IoT/GPS/Telemetry integrations do **not exist** in the legacy platform — a scooter is a database
record whose battery and GPS are persisted fields, so those "adapters" collapse into the
repository-backed read model rather than inventing infrastructure (scope: existing only). Wallet
write logic is **reused, not migrated** (end-ride charge delegates to the existing
`WalletRepository` behind a gateway port). Trips, Fleet, Payments, AI untouched.

## 2. Files Created (14)

**Domain (pure):** `src/domain/scooters/scooterValues.js` · `scooterPolicies.js` · `Scooter.js`
**Application:** `src/application/scooters/ports.js` · `commands.js` · `useCases.js` · `index.js`
**Infrastructure:** `src/infrastructure/repositories/scooterRepositoryAdapter.js` ·
`scooterReadModelAdapter.js` · `src/infrastructure/gateways/scooterGateways.js`
**Presentation:** `src/presentation/api/scootersController.js` · `scootersRoutes.js`
**Tests:** `tests/unit/scooters.test.js` · `tests/integration/scooters-ab.mjs`

## 3. Files Modified (1)

`server.js` — a single guarded cutover block (10 lines): the new Scooters router is default;
`SCOOTERS_LEGACY=1` restores the legacy router. No other runtime code changed. (Prettier
auto-formatted the new files; no logic change.)

## 4. Mounted Components (carrying traffic)

`scootersRoutes.js` → `scootersController.js` → `src/application/scooters/*` →
`src/domain/scooters/*` → ports → `src/infrastructure/{repositories,gateways}/scooter*` →
existing `ScooterRepository`, `WalletRepository` (reused), `NotificationRepository`, cache, and the
serialized `dbTransaction`. All 11 endpoints flow Presentation → Application → Domain → Ports →
Infrastructure, no layer skipped.

## 5. Legacy Components Remaining

`src/routes/scooters.js` — **unchanged this phase, unmounted by default.** It is the provably
identical rollback target (the A/B harness executes it as the "legacy" arm). Dead code pending a
later retirement, not a business-logic holder.

## 6. Security Report (ADR-007)

| Control | Status | Evidence |
|---|---|---|
| JWT authentication | ✅ preserved | `authenticate` on unlock/end-ride/history/active; A/B `*:noauth → 401` |
| Admin RBAC | ✅ preserved | `authenticateAdmin` on add/delete/reset; A/B `admin:*:noauth → 401` |
| Ownership (end-ride) | ✅ enforced in Domain | `lockPolicy`; A/B `endride:notyours → 403` |
| Unlock authorization | ✅ ordered gates in Domain | `unlockPolicy` (available→balance→battery); A/B parity |
| IDOR prevention | ✅ JWT-only identity | history/active use `req.user.phone`, ignore path phone (legacy behavior preserved) |
| Atomic claim (anti-race) | ✅ preserved | `setRiding` WHERE available; `UNLOCK_RACE_LOST → 409` |
| Rate limiting | ✅ unchanged | global limiter untouched |
| No security regression | ✅ | 24/24 A/B including all auth/ownership/gate scenarios |

## 7. Architecture Compliance Report

Verifier `architecture/compliance/verify-architecture.mjs`: **PASS, 0 violations**, now scanning
**52 enterprise-layer files** (domain/application/infrastructure/presentation across Identity,
Users, Localization, Drivers, Scooters). Rules R1–R7 all green: no framework in Domain/Application,
no SQL outside Infrastructure, controller imports no Domain/Infra, Domain pure, Application
downward-only, no cycles, ports asserted. **CI Architecture Gate (Phase 3.6) enforces this on
every PR/push.**

## 8. ADR Compliance Addendum

- **ADR-002 (Domain Model):** Scooter aggregate + ScooterStatus/BatteryLevel/ScooterCode/
  Availability value objects + Unlock/Lock/Availability/Battery policies (pure). → **Impl**
- **ADR-003 (Globalization):** Arabic frozen default (byte-identical); English additive via
  `Accept-Language`. → **Impl**
- **ADR-004 (Data):** read models as disposable projections; ride settlement + wallet charge inside
  one serialized transaction boundary (C-1 safe); append-only transaction fact reused. → **Part**
  (Postgres cutover still Planned)
- **ADR-005 (Application):** five layers, ports/fail-fast, one transaction boundary, gates before
  domain. → **Impl**
- **ADR-006 (Integration):** frozen REST/JSON contract, A/B 24/24. → **Part** (events Planned)
- **ADR-007 (Security):** §6 above. → **Impl**
- **ADR-008 (Technical):** layout + DI composition root. → **Impl**
- **ADR-009/010:** unchanged (infra present, not per-context). → **Part**
- **ADR-012/013/014/015:** governance artifacts synchronized; roadmap advanced; reference/matrix
  updated; manifesto upheld (evolve-in-place, contracts frozen, evidence-backed). → **Impl**
- **ADR-011 (AI):** N/A.

## 9. Updated Traceability Matrix

`architecture/compliance/MATRIX.md` — Scooters row upgraded to `Impl` for ADR-002/003/005/008,
`Impl` for 007, `Part` for 004/006/009/010. Fully ADR-005-compliant contexts now **5/11**
(Identity, Users, Localization, Drivers, Scooters).

## 10. Updated Evidence Mapping

`architecture/compliance/EVIDENCE.md` — Scooters rows added under ADR-002/003/005/006/007 pointing
at the new source files, `tests/unit/scooters.test.js`, and `tests/integration/scooters-ab.mjs`
(24/24).

## 11. Updated Repository Readiness Report

`architecture/compliance/REPOSITORY-READINESS.md` — Scooters complete; next context proceeds under
the enforced gate; Wallet/Payments remain gated on ADR-001.

## 12. Test Results (executed)

- **Unit:** 107/107 pass (added the Scooters slice; coverage increased).
- **A/B compatibility:** Scooters **24/24 byte-identical** — covering discovery, details (found/
  missing), admin add (valid/bad-coords/no-auth), unlock (missing/no-auth/low-balance/**happy**),
  active (riding/none/after), **end-ride happy path** (transaction + wallet charge + notification),
  history, deprecated 410s, ownership 403, admin delete, reset (auth/no-auth).
- **Regression (no existing test failed):** Identity 35/35 · Users 17/17 · Drivers 14/14 A/B — all
  still byte-identical.
- **IoT/Adapter tests:** covered by the read-model/gateway unit fakes + the live end-ride A/B (no
  separate IoT hardware exists to test).
- **Architecture:** verifier PASS (52 files). **Lint + Format:** clean (whole tree).

## 13. Rollback Procedure

`SCOOTERS_LEGACY=1` in the environment + restart → the legacy `src/routes/scooters.js` serves all
scooter traffic. The rollback path is itself live-proven (the harness's legacy arm is exactly
rollback mode). No data migration in either direction — both routers use the same tables via the
same repositories. Full code rollback: revert the one `server.js` block.

## 14. Technical Debt

1. `src/routes/scooters.js` dead code — retire after a production soak.
2. Reservation/Firmware/Diagnostics/live-IoT remain **absent by design** (not legacy features); if
   ever built they enter as new capabilities under a fresh scope, not this migration.
3. Wallet charge is reused via a gateway; when the Wallet context is formalized, the
   `walletGateway` should target a Wallet-owned application service (gated on ADR-001).
4. Cache/rate-limit remain in-process (platform-wide debt, unchanged) — Redis is forward-provisioned.

## 15. Architecture Drift Report

**Zero drift introduced.** The verifier passes with 0 violations at 52 files; the CI gate blocks any
future PR that would introduce drift. No layer boundary was crossed (mechanically confirmed). The
only cross-context touch — end-ride's wallet charge and reset's taxi-online side-effect — are
confined to Infrastructure gateways that delegate to existing integrations, preserving both the
contract and the layering.

## 16. ADR Coverage Delta (this phase)

| ADR | Before (Scooters) | After (Scooters) |
|---|---|---|
| 002 Domain | Part | **Impl** |
| 003 Global | Plan | **Impl** |
| 004 Data | Part | Part |
| 005 App | Plan | **Impl** |
| 006 Integ | Plan | **Part** |
| 007 Sec | Part | **Impl** |
| 008 Tech | Part | **Impl** |
| 013 Road | Plan | **Impl** |
| 014 Ref | Part | **Impl** |
| 015 Manif | Part | **Impl** |

Platform: fully ADR-005-compliant contexts **4 → 5 / 11**.

## 17. Phase 6 Readiness Assessment

**READY.** The Scooters context is migrated, byte-compatible (24/24), security-preserving,
verifier-clean, CI-gated, and instantly reversible; governance artifacts are synchronized.
Recommended next: **Notifications** or **Admin** (both moderate surface, no Commerce invariants),
continuing under the A/B + verifier + CI discipline. **Wallet/Payments remain last, gated on the
ADR-001 decision** — this phase deliberately reused (never migrated) Wallet write logic so that
gate is not pre-empted. Phase 6 begins only under an approved bounded-context mandate + A/B plan.

---

*Migration executed under the Strangler Fig pattern. Every PASS is backed by an executed test or a
mechanical check. No legacy behavior changed; no new business feature added; public contracts
frozen and proven byte-identical.*
