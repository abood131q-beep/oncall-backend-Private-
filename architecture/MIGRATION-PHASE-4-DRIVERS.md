# Enterprise Architecture Migration — Phase 4 (Drivers)

**Pattern:** Strangler Fig · **Date:** 2026-07-19 · **Status:** cutover implemented and compatibility-proven.

## 1. Migration summary

Drivers now use the ADR-005 chain **Presentation → Application → Domain → ports → Infrastructure** by default. `DRIVERS_LEGACY=1` restores the original `src/routes/drivers.js` plus the original admin driver handlers immediately. Driver login remains in the already-migrated Identity context. No Trips, Fleet, Wallet, Payments, database schema, or public route was changed.

## 2. Files created

- Domain: `src/domain/drivers/{Driver,driverValues,driverPolicies}.js`
- Application: `src/application/drivers/{commands,index,ports,useCases}.js`
- Infrastructure: `driverRepositoryAdapter.js`, `driverReadModelAdapter.js`, `driverDocumentsAdapter.js`, `driverLocationAdapter.js`, `driverSessionControlAdapter.js`
- Presentation: `src/presentation/api/{driversController,driversRoutes}.js`
- Proof: `tests/unit/drivers.test.js`, `tests/integration/drivers-ab.mjs`

## 3. Files modified and mounted

`server.js` is the sole runtime mount change. It selects the new Drivers router unless `DRIVERS_LEGACY=1`; legacy files are otherwise untouched. `package.json` expands the existing unit-test command to discover all `tests/unit/*.test.js` suites. The mounted flow carries all existing Driver HTTP operations: availability, profile, update, trips read model, stats, reviews, admin list/pending/read/toggle, approval, rejection, suspension, reactivation, and approval history.

## 4. Legacy and scope boundaries

`src/routes/drivers.js` and the Driver sections of `src/routes/admin.js` remain unmodified as the rollback implementation. Existing driver documents have no API/table and so no feature was invented. Existing driver location is the Trip-owned Socket.IO event (`driver:location`); it remains untouched because Phase 4 explicitly forbids migrating Trips. Notifications have no Driver-specific HTTP endpoint; their existing generic surface remains untouched.

## 5. Compatibility report

The real server was booted twice against fresh temporary databases using the existing SQLite compatibility preload: legacy (`DRIVERS_LEGACY=1`) and enterprise. The harness compares HTTP status plus raw JSON text, preserving key order; only JWTs and datetimes are normalized. **Result: 14/14 byte-identical.** Cases cover pending login, admin listing/pending, authenticated and unauthenticated approval, status, JWT-owned profile path, profile update, statistics, reviews, invalid rejection reason, suspend, reactivate, and audit history.

## 6. Security report

Authentication middleware and route order are unchanged. Driver-owned endpoints derive the subject from `req.user.phone`, preserving IDOR protection when the path carries another phone. Admin operations retain `authenticateAdmin`. Approval policies preserve state conflicts and reason validation. Suspension performs its state transaction before revoking access tokens, refresh tokens, and sockets; this ordering matches the legacy hardened P6-06 behavior. Arabic output is unchanged by default; English error text is additive when `Accept-Language: en` is supplied.

## 7. Architecture and ADR compliance

The verifier passes **R1–R7, 0 violations, 40 enterprise-layer files scanned**. Domain is pure; no SQL occurs outside Infrastructure; controllers import Application only; adapter wiring is confined to the Presentation composition root. ADR-002/003/004/005/006/007/008/012/013/014/015 are evidenced in `architecture/compliance/{MATRIX,EVIDENCE}.md`; ADR-009/010 are unchanged platform controls; ADR-011 remains N/A for Drivers.

## 8. Test results

- Drivers domain/application unit suite: **7/7 PASS**.
- Drivers A/B compatibility: **14/14 PASS**.
- Existing repository unit suite: **55/55 PASS** before test discovery expansion.
- ESLint: PASS. Prettier: PASS. Architecture verifier: PASS (0 violations).

## 9. Rollback

Set `DRIVERS_LEGACY=1` and restart. This mounts the untouched `src/routes/drivers.js`; the existing legacy admin router continues to own every `/admin/drivers/*` path. No schema or data migration exists, so rollback has no data step. The A/B legacy arm is the same rollback configuration.

## 10. Technical debt and Phase 5 readiness

1. Driver documents and notifications have no Driver-specific legacy API; model/mount them only when an existing contract is introduced under a separate approved scope.
2. `driver:location` remains Trip-owned and is deliberately deferred with Trips.
3. The pre-existing SQLite transaction-isolation and observability debts remain unchanged.

**Phase 5 readiness: READY**, subject to the mandatory CI Architecture Verification check and the normal protected-branch policy. The next migration must remain within its approved bounded context.
