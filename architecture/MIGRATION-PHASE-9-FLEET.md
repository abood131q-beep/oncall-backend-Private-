# Enterprise Architecture Migration — Phase 9 Record (Fleet Cutover)

**Pattern:** Strangler Fig · **Authority:** G0.0 · ADR-002…015 · **Date:** 2026-07-20
**Status:** Cutover implemented and A/B-proven (14/14). Legacy retained behind `FLEET_LEGACY=1`.

---

## 1. Migration Report (summary)

The **Fleet bounded context** — the platform's vehicle inventory (the legacy `taxis` table) — is
migrated into the ADR-005 layered architecture using the proven Strangler recipe. Fleet's three
public HTTP endpoints had no dedicated router; they were **co-located** inside Trips (`GET /taxis`)
and Admin (`POST /admin/taxis`, `DELETE /admin/taxis/:id`). This phase **extracts all three into a
Fleet context that now owns them.** The new Fleet router is mounted **before** Trips and Admin, so
first-match makes it the sole active owner; the still-mounted co-located handlers become the instant
rollback via `FLEET_LEGACY=1`. Runtime behavior is unchanged and the contract is frozen.

**Design principle — reuse the persistence, migrate the decisions.** The Domain owns the fleet
invariants (registration validity, the sanitized public projection, the online⇒available/assignable
semantics). The `taxis` persistence and the existing 10-second read cache are **reused verbatim
behind the repository adapter, never reimplemented** — including the legacy behavior that
registration/removal do **not** invalidate the cache (only the TTL does).

**Scope migrated:** exactly the three pre-existing Fleet HTTP endpoints — public vehicle lookup /
availability (`GET /taxis`), vehicle registration (`POST /admin/taxis`), vehicle removal
(`DELETE /admin/taxis/:id`). No new Fleet capability was introduced.

**NOT migrated (reused-in-place, unchanged):** the vehicle **status/location writes** performed
across the driver, trip, scooter, and Socket.IO lifecycle (`UPDATE taxis SET status/lat/lng …`)
are not Fleet HTTP endpoints — they are owned side-effects of those contexts and remain reused
in place, exactly as before (changing them would alter runtime behavior and exceed scope).
**Wallet, Payments, AI** are not migrated.

## 2. Files Created (9)

**Domain (pure):** `src/domain/fleet/fleetValues.js` · `fleetPolicies.js` · `Fleet.js`
**Application:** `src/application/fleet/ports.js` · `commands.js` · `useCases.js` · `index.js`
**Infrastructure:** `src/infrastructure/repositories/fleetRepositoryAdapter.js`
**Presentation:** `src/presentation/api/fleetController.js` · `fleetRoutes.js`
**Tests:** `tests/unit/fleet.test.js` · `tests/integration/fleet-ab.mjs`

*(Domain/Application/Infra/Presentation = 9 source files; plus 2 test files.)*

## 3. Files Modified (1)

`server.js` — a single guarded cutover block, placed **before** the Trips block: the new Fleet
router is default and owns `/taxis` + `/admin/taxis`; `FLEET_LEGACY=1` removes it so the co-located
Trips/Admin handlers resume serving those paths. No other runtime code changed. (The co-located
handlers in `tripsRoutes`/`adminRoutes` are intentionally left in place as the rollback target.)

## 4. Mounted Components (carrying traffic)

`fleetRoutes.js` → `fleetController.js` → `src/application/fleet/*` → `src/domain/fleet/*` → ports →
`fleetRepositoryAdapter`. Reuses `dbAll`/`dbRun`, the `cache` service (`getCache`/`setCache`,
`CACHE_TTL.taxis`), and `validateCoords`. Mounted ahead of Trips/Admin so it is the sole active
owner of the three Fleet paths.

## 5. Legacy Components Remaining

The co-located Fleet handlers — `GET /taxis` in `tripsController`/`tripCoLocatedGateways` and
`POST/DELETE /admin/taxis` in `adminController`/`adminRepositoryAdapter` — remain mounted but are
**shadowed** by the Fleet router (first-match). They are retained solely as the provably-identical
`FLEET_LEGACY=1` rollback target (the A/B harness executes them as the "legacy" arm). Retire after a
production soak. `src/routes/taxi.js` / `src/routes/admin.js` remain the deeper `TRIPS_LEGACY` /
`ADMIN_LEGACY` rollback targets, unchanged.

## 6. Security Report (ADR-007)

| Control | Status | Evidence |
|---|---|---|
| JWT authentication | ✅ preserved | `authenticateAdmin` on register/remove; A/B `add:noauth`/`delete:noauth → 401` |
| RBAC (admin) | ✅ preserved | admin gate unchanged; A/B `add:passenger`/`delete:passenger → 403` |
| Public read scope | ✅ preserved | `GET /taxis` stays unauthenticated (legacy contract), returns only the sanitized projection |
| IDOR / data exposure | ✅ | `fleetValidationPolicy` exposes exactly `{id,name,lat,lng,status}` — no `driver_id` or other column leaks (unit + A/B) |
| Input validation | ✅ preserved | `fleetRegistrationPolicy` = name required + coords valid/Kuwait-default; A/B `add:noname`/`add:blankname`/`add:badcoords → 400` |
| Rate limiting | ✅ unchanged | global limiter untouched |
| No security regression | ✅ | 14/14 A/B incl. every auth/RBAC/validation/exposure scenario |

## 7. Architecture Compliance Report

Verifier: **PASS, 0 violations**, now scanning **89 enterprise-layer files** across nine contexts
(domain 24 · application 33 · infrastructure 22 · presentation 16 — counts include the shared
governance tree). Rules R1–R7 green: no framework/SQL in Domain/Application, presentation imports no
Domain, controller imports no Infra/DB, Domain pure, Application downward-only, no cycles, ports
asserted. The CI Architecture Gate enforces this on every PR/push.

## 8. ADR Compliance Addendum

- **ADR-002:** Vehicle aggregate + VehicleId/VehicleStatus/FleetAvailability VOs + Registration /
  Validation / Availability / Assignment policies (pure). → **Impl**
- **ADR-003:** Arabic frozen default (byte-identical); English additive via `Accept-Language` on the
  registration validation messages. A/B `add:noname:en` / `add:badcoords:en` parity. → **Impl**
- **ADR-004:** `taxis` reads/writes + read cache reused verbatim behind the repository adapter. → **Part** (Postgres cutover Planned)
- **ADR-005:** four layers, ports/fail-fast composition, gates before domain, thin controller. → **Impl**
- **ADR-006:** frozen REST/JSON contract preserved across all 3 endpoints; A/B 14/14. → **Part**
- **ADR-007:** §6 above. → **Impl**
- **ADR-008:** layout + DI composition root. → **Impl**
- **ADR-009/010:** unchanged. → **Part**
- **ADR-011 (AI):** N/A · **ADR-012/013/014/015:** governance synced; roadmap advanced; manifesto upheld. → **Impl**

**Scope note (VehicleRepository / LocationGateway / NotificationGateway).** These appear on the
Fleet capability map, but **no existing Fleet HTTP endpoint exercises them**: per-vehicle lookups
are not a legacy endpoint, vehicle location/status writes are owned side-effects of the
Drivers/Trips/Scooters/Socket lifecycle (reused in place), and Fleet has no legacy notification
behavior. Wiring dead adapters would introduce new functionality, which this phase forbids — so
their semantics are captured purely in the Domain policies (Availability/Assignment) and tracked as
debt for the lifecycle-extraction phase.

## 9. Updated Traceability Matrix

`architecture/compliance/MATRIX.md` — Fleet row upgraded from all-`Plan` to `Impl` for
ADR-002/003/005/007/008. Fully ADR-005-compliant contexts now **9/11** (Identity, Users,
Localization, Drivers, Scooters, Notifications, Trips, Admin, Fleet).

## 10. Updated Evidence Mapping

`architecture/compliance/EVIDENCE.md` — Fleet rows added (ADR-002/003/005/006/007) pointing at the
new sources, `tests/unit/fleet.test.js`, and `tests/integration/fleet-ab.mjs` (14/14).

## 11. Updated Repository Readiness Report

`architecture/compliance/REPOSITORY-READINESS.md` — Fleet complete; remaining legacy contexts are
Wallet, Payments, AI; Wallet/Payments remain last, gated on ADR-001.

## 12. Test Results (executed)

- **Unit:** 152/152 pass (added the 10-case Fleet slice; coverage increased).
- **A/B compatibility:** Fleet **14/14 byte-identical** — public list, register (auth 401, RBAC 403,
  no-name/blank-name/bad-coords 400, success with default + explicit coords), remove (auth 401, RBAC
  403, unconditional delete of missing + real id 200), and additive-English localization.
- **Regression (no existing test failed):** Identity 35 · Users 17 · Drivers 14 · Scooters 24 ·
  Trips 31 · Notifications 21 · Admin 43 — all still byte-identical (199 A/B scenarios total). Note:
  the Trips (`taxis:list`) and Admin (`taxi:add/delete`) harnesses still pass with Fleet active,
  proving the extracted endpoints match the deeper legacy routers as well.
- **Architecture:** verifier PASS (89 files). **Lint + Format:** clean (whole tree).

## 13. Rollback Procedure

`FLEET_LEGACY=1` + restart → the co-located handlers in the Trips/Admin routers resume serving
`/taxis` and `/admin/taxis`. Rollback path is live-proven (the harness's legacy arm is exactly
rollback mode). No data migration — same `taxis` table via the same db/cache. The switch is
independent of `TRIPS_LEGACY`/`ADMIN_LEGACY`. Full code rollback: revert the one `server.js` block.

## 14. Technical Debt

1. Co-located Fleet handlers in `tripsRoutes`/`adminRoutes` (and their gateways/adapters) are now
   dead when Fleet is active — remove after a production soak once the cutover is permanent.
2. Vehicle **location/status lifecycle writes** remain scattered across Drivers/Trips/Scooters/
   Socket. Extracting them behind a Fleet `LocationGateway` (so those contexts reuse Fleet as the
   vehicle owner) is a follow-up that must preserve behavior — deferred to avoid touching working
   lifecycle code this phase.
3. `taxis` persistence + cache reused verbatim — natural home for the ADR-004 Postgres read-model
   cutover and a future cache-invalidation-on-write decision (kept legacy-identical for now).
4. `taxis` and `scooters` inventories could later share a generic Fleet vehicle abstraction.

## 15. Architecture Drift Report

**Zero drift.** Verifier passes at 89 files with 0 violations; the CI gate blocks any regression.
The previously homeless Fleet endpoints — scattered across two other contexts — now flow through a
single clean-layered context with the decisions in the Domain and the persistence/cache reused
behind a port. Two co-location debts (Trips `/taxis`, Admin `/admin/taxis`) recorded in Phases 7–8
are now **paid down** (mechanically confirmed).

## 16. ADR Coverage Delta (this phase)

| ADR | Before (Fleet) | After (Fleet) |
|---|---|---|
| 002 Domain | Plan | **Impl** |
| 003 Global | Plan | **Impl** |
| 005 App | Plan | **Impl** |
| 006 Integ | Plan | **Part** |
| 007 Sec | Plan | **Impl** |
| 008 Tech | Part | **Impl** |
| 013/014/015 | Plan/Part | **Impl** |

Platform: fully ADR-005-compliant contexts **8 → 9 / 11**.

## 17. Phase 10 Readiness Assessment

**READY.** Fleet is migrated, byte-compatible (14/14), security-preserving, verifier-clean,
CI-gated, instantly reversible; governance artifacts synchronized; two prior co-location debts paid.
The remaining legacy contexts are **Wallet**, **Payments**, and **AI**. Recommended next: **AI**
(self-contained, no Commerce invariants) or the **Fleet lifecycle-write extraction** follow-up.
**Wallet & Payments remain last, gated on the ADR-001 decision** — every prior phase deliberately
reused (never migrated) the payment path to keep that gate intact. Phase 10 begins only under an
approved bounded-context mandate + A/B plan.

---

*Migration executed under the Strangler Fig pattern. Every PASS is backed by an executed test or a
mechanical check. No legacy behavior changed; no new Fleet feature added; public contracts frozen
and proven byte-identical across all three Fleet endpoints; persistence and cache reused, not
reimplemented; two co-location debts retired.*
