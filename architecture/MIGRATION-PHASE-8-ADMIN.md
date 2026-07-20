# Enterprise Architecture Migration — Phase 8 Record (Admin Cutover)

**Pattern:** Strangler Fig · **Authority:** G0.0 · ADR-002…015 · **Date:** 2026-07-20
**Status:** Cutover implemented and A/B-proven (43/43). Legacy retained behind `ADMIN_LEGACY=1`.

---

## 1. Migration Report (summary)

The **Admin bounded context** — the platform's operational control surface (legacy
`src/routes/admin.js`, ~1166 lines) — is migrated into the ADR-005 layered architecture using the
proven Strangler recipe. The new router is default; the legacy admin router is the instant,
byte-identical rollback via `ADMIN_LEGACY=1`. Runtime behavior is unchanged; **all 28 general admin
endpoints are frozen and proven byte-identical**: statistics/dashboard/revenue/analytics, trip &
user & taxi & report administration, and the audit / maintenance / configuration / observability
surface (backups, restore, logs, db-health, vacuum, reindex, system, metrics, security-events,
errors, crashes, notification-stats, shutdown).

**Design principle — reuse heavy integrations, migrate the decisions.** The Domain owns the admin
invariants (RBAC / pagination & clamp normalization / taxi-creation validity / DB-restore &
shutdown maintenance guards / audit classification). The heavy legacy machinery is **reused via
Infrastructure adapters, never reimplemented**: the dashboard/stats/revenue SQL (verbatim), the
`analytics` service, the structured `logger` (logs/security/errors/crashes), the `metrics`
collector, FS backups, PRAGMA maintenance, `os`/`process` introspection, and the process-lifecycle
(restore/shutdown) calls. This keeps the migration behavior-preserving while confining the layering.

**Scope migrated:** exactly the pre-existing general Admin capability listed above. No new
administrative feature was introduced.

**NOT migrated (out of scope, unchanged):** the driver-approval workflow (`/admin/drivers/*`) was
migrated with **Drivers (Phase 4)** and is untouched here; **Wallet, Payments, Fleet, AI** are not
migrated. The taxi write endpoints (`POST/DELETE /admin/taxis`) are co-located Fleet passthroughs
kept byte-identical (raw INSERT/DELETE preserved) pending the Fleet phase.

## 2. Files Created (11)

**Domain (pure):** `src/domain/admin/adminValues.js` · `adminPolicies.js` · `Admin.js`
**Application:** `src/application/admin/ports.js` · `commands.js` · `useCases.js` · `index.js`
**Infrastructure:** `src/infrastructure/repositories/adminRepositoryAdapter.js` ·
`src/infrastructure/gateways/adminOpsGateways.js`
**Presentation:** `src/presentation/api/adminController.js` · `adminRoutes.js`
**Tests:** `tests/unit/admin.test.js` · `tests/integration/admin-ab.mjs`

*(Domain/Application/Infra/Presentation = 11 source files; plus 2 test files.)*

## 3. Files Modified (1)

`server.js` — a single guarded cutover block: the new Admin router is default and owns every general
endpoint; `ADMIN_LEGACY=1` removes it so the legacy router owns them again. The legacy admin router
remains mounted **after** the new one so it continues to serve the co-located `/admin/drivers*`
endpoints in the `DRIVERS_LEGACY` rollback path (first-match means the new router owns all general
endpoints while active). No other runtime code changed.

## 4. Mounted Components (carrying traffic)

`adminRoutes.js` → `adminController.js` → `src/application/admin/*` → `src/domain/admin/*` → ports →
`adminRepositoryAdapter` + `adminOpsGateways` (audit / configuration / notification / logging).
Reuses `dbGet/dbAll/dbRun`, `UserRepository`, `DriverRepository`, `TripRepository`,
`ReportRepository`, the `analytics` service, `logger`, `getMetrics`, `createBackup`, `notifService`,
`io`, `validateCoords`, and `formatTrip`.

## 5. Legacy Components Remaining

`src/routes/admin.js` — **unchanged this phase.** Its 28 general endpoints are shadowed by the new
router (dead but retained as the provably-identical rollback target — the A/B harness executes it as
the "legacy" arm). Its `/admin/drivers*` endpoints remain the fallback for the `DRIVERS_LEGACY`
rollback path. Retire after a production soak once both cutovers are permanent.

## 6. Security Report (ADR-007)

| Control | Status | Evidence |
|---|---|---|
| JWT authentication | ✅ preserved | `authenticateAdmin` on all 28 routes; A/B `stats:noauth → 401` |
| RBAC (admin) | ✅ preserved | admin-role/allowlist gate unchanged; A/B `stats:passenger → 403` |
| RBAC domain policy | ✅ codified | `rbacPolicy` extracts the legacy admin gate into the pure Domain |
| Path traversal (restore) | ✅ preserved | `restorePolicy` = legacy `basename` + `^[\w\-. ]+\.db$` + no leading `.` + `safe===filename`; A/B `restore:badname/traversal → 400` |
| Destructive-op confirmation | ✅ preserved | restore requires `RESTORE_CONFIRMED`, shutdown requires `SHUTDOWN_CONFIRMED`; A/B `restore:noconfirm`/`shutdown:noconfirm → 400` |
| DoS guard (pagination) | ✅ preserved | `normalizePagination` caps limit at 100 (legacy math); A/B `trips:badpage` parity |
| Observability clamps | ✅ preserved | `clampN` bounds n for security-events/errors/crashes (legacy caps) |
| Rate limiting | ✅ unchanged | global limiter untouched |
| No security regression | ✅ | 43/43 A/B incl. every auth, RBAC, traversal, and confirm-token scenario |

## 7. Architecture Compliance Report

Verifier: **PASS, 0 violations**, now scanning **86 enterprise-layer files** across eight contexts
(domain 22 · application 29 · infrastructure 21 · presentation 14). Rules R1–R7 green: no
framework/SQL in Domain/Application, presentation imports no Domain, controller imports no
Infra/DB, Domain pure, Application downward-only, no cycles, ports asserted. The CI Architecture
Gate enforces this on every PR/push.

## 8. ADR Compliance Addendum

- **ADR-002:** Admin aggregate + AdminRole/Permission/AuditAction VOs + RBAC / Approval / Audit /
  Maintenance / AdministrativeAccess policies (pure). → **Impl**
- **ADR-003:** Arabic frozen default (byte-identical); English additive via `Accept-Language`
  (taxi/restore/shutdown/user-not-found messages). A/B `user:get:missing:ar-header` parity. → **Impl**
- **ADR-004:** dashboard/stats/revenue SQL reused verbatim behind the repository adapter; read
  models projected unchanged. → **Part** (Postgres cutover Planned)
- **ADR-005:** five layers, ports/fail-fast composition, gates before domain, thin controllers. → **Impl**
- **ADR-006:** frozen REST/JSON contract preserved across all 28 endpoints; A/B 43/43. → **Part**
- **ADR-007:** §6 above. → **Impl**
- **ADR-008:** layout + DI composition root. → **Impl**
- **ADR-009/010:** unchanged; observability endpoints reused. → **Part**
- **ADR-011 (AI):** N/A · **ADR-012/013/014/015:** governance synced; roadmap advanced; manifesto upheld. → **Impl**

## 9. Updated Traceability Matrix

`architecture/compliance/MATRIX.md` — Admin row upgraded to `Impl` for ADR-002/003/005/007/008.
Fully ADR-005-compliant contexts now **8/11** (Identity, Users, Localization, Drivers, Scooters,
Notifications, Trips, Admin).

## 10. Updated Evidence Mapping

`architecture/compliance/EVIDENCE.md` — Admin rows added (ADR-002/003/005/006/007) pointing at the
new sources, `tests/unit/admin.test.js`, and `tests/integration/admin-ab.mjs` (43/43).

## 11. Updated Repository Readiness Report

`architecture/compliance/REPOSITORY-READINESS.md` — Admin complete; remaining legacy contexts are
Fleet, Wallet, Payments, AI; Wallet/Payments remain last, gated on ADR-001.

## 12. Test Results (executed)

- **Unit:** 142/142 pass (added the 15-case Admin slice; coverage increased).
- **A/B compatibility:** Admin **43/43 byte-identical** — auth (401/403), RBAC, every read
  (stats/dashboard/revenue/analytics/users/reports/backups/logs/db-health/system/metrics/
  security-events/errors/crashes/notification-stats), trip cancel (404 + ok), user toggle (ok +
  404), taxi add/delete (name/coords validation), report resolve, backup create, db vacuum/reindex,
  logs clear, and the destructive-op guards (restore no-confirm/bad-name/traversal/missing,
  shutdown no-confirm). Nondeterministic observability payloads (pids, uptimes, memory/cpu gauges,
  backup filenames, log lines with UUIDs, timing-sorted route lists) are normalized so only the
  frozen contract is compared.
- **Regression (no existing test failed):** Identity 35 · Users 17 · Drivers 14 · Scooters 24 ·
  Trips 31 · Notifications 21 — all still byte-identical (185 A/B scenarios total).
- **Architecture:** verifier PASS (86 files). **Lint + Format:** clean (whole tree).

## 13. Rollback Procedure

`ADMIN_LEGACY=1` + restart → legacy `src/routes/admin.js` serves all general admin traffic. Rollback
path is live-proven (the harness's legacy arm is exactly rollback mode). No data migration — same
tables via the same repositories/services. The switch is independent of `DRIVERS_LEGACY`: the legacy
admin router stays mounted as the trailing fallback, so the driver-approval rollback path is
unaffected. Full code rollback: revert the one `server.js` block.

## 14. Technical Debt

1. `src/routes/admin.js` dead general endpoints — retire after a production soak (kept as the
   rollback target and the `/admin/drivers*` fallback until Drivers cutover is permanent).
2. `POST/DELETE /admin/taxis` are co-located Fleet passthroughs (raw INSERT/DELETE) — extract into
   the Fleet context in a later phase.
3. Dashboard/stats/revenue SQL is reused verbatim in the repository adapter — natural home for the
   ADR-004 Postgres read-model cutover.
4. Restore/shutdown perform `process.exit` inside the infrastructure gateway (legacy behavior); the
   A/B harness proves only their validation-failure paths in-process, by necessity.

## 15. Architecture Drift Report

**Zero drift.** Verifier passes at 86 files with 0 violations; the CI gate blocks any regression.
The platform's broadest handler surface (28 heterogeneous endpoints mixing SQL, FS, PRAGMA, `os`,
`child_process`, and process lifecycle) now flows through clean layers with the decisions in the
Domain and every integration reused behind ports — no boundary crossed by the new code (mechanically
confirmed).

## 16. ADR Coverage Delta (this phase)

| ADR | Before (Admin) | After (Admin) |
|---|---|---|
| 002 Domain | Part | **Impl** |
| 003 Global | Plan | **Impl** |
| 005 App | Plan | **Impl** |
| 006 Integ | Plan | **Part** |
| 007 Sec | Part | **Impl** |
| 008 Tech | Part | **Impl** |
| 013/014/015 | Plan/Part | **Impl** |

Platform: fully ADR-005-compliant contexts **7 → 8 / 11**.

## 17. Phase 9 Readiness Assessment

**READY.** Admin is migrated, byte-compatible (43/43), security-preserving, verifier-clean,
CI-gated, instantly reversible; governance artifacts synchronized. The remaining legacy contexts
are **Fleet**, **Wallet**, **Payments**, and **AI**. Recommended next: **Fleet** (small; unblocks
extracting the co-located `/taxis` from Trips and `POST/DELETE /admin/taxis` from Admin). **Wallet &
Payments remain last, gated on the ADR-001 decision** — every prior phase deliberately reused (never
migrated) the payment path to keep that gate intact. Phase 9 begins only under an approved
bounded-context mandate + A/B plan.

---

*Migration executed under the Strangler Fig pattern. Every PASS is backed by an executed test or a
mechanical check. No legacy behavior changed; no new administrative feature added; public contracts
frozen and proven byte-identical across all 28 general admin endpoints; heavy integrations reused,
not reimplemented.*
