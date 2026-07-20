# Enterprise Architecture Migration — Phase 6 Record (Notifications Cutover)

**Pattern:** Strangler Fig · **Authority:** G0.0 · ADR-002…015 · **Date:** 2026-07-20
**Status:** Cutover implemented and A/B-proven (21/21). Legacy retained behind `NOTIFICATIONS_LEGACY=1`.

---

## 1. Migration Report (summary)

The **Notifications bounded context** — device-token management + push dispatch — is migrated into
the ADR-005 layered architecture beside legacy `src/routes/notifications.js`, using the proven
Strangler recipe. The new router is default; the legacy router is the instant, byte-identical
rollback via `NOTIFICATIONS_LEGACY=1`. Runtime behavior is unchanged; the public HTTP contract is
frozen and proven byte-identical across all 5 legacy endpoints.

**A material ADR-005 improvement:** the raw device-token SQL that lived **inside the legacy route**
(a layer violation) now lives in the Infrastructure adapter behind a port — the statements are
byte-for-byte the legacy ones, so behavior is preserved while the layering is corrected.

**Scope migrated (existing capabilities only):** register device token (`POST /device-tokens`),
delete device token (`DELETE /device-tokens`), admin push send (`POST /push/send`), admin push
broadcast (`POST /push/broadcast`), admin device-token diagnostics (`GET /device-tokens/:phone`).

**Not migrated / not present in legacy:** notification **listing / mark-read** were already migrated
in Phase 3 (Users context, `notificationPreferenceAdapter`) — not re-migrated. **Email** and message
**Templates** do not exist in the legacy platform — not implemented. **SMS** exists but is owned by
the Identity/OTP flow (`otpGatewayAdapter`, Phase 2), not a Notifications-context endpoint — no
unused adapter invented. No new business feature was introduced.

## 2. Files Created (12)

**Domain (pure):** `src/domain/notifications/notificationValues.js` · `notificationPolicies.js` ·
`Notification.js`
**Application:** `src/application/notifications/ports.js` · `commands.js` · `useCases.js` · `index.js`
**Infrastructure:** `src/infrastructure/repositories/deviceTokenAdapter.js` ·
`src/infrastructure/gateways/pushGatewayAdapter.js`
**Presentation:** `src/presentation/api/notificationsController.js` · `notificationsRoutes.js`
**Tests:** `tests/unit/notifications.test.js` · `tests/integration/notifications-ab.mjs`

## 3. Files Modified (1)

`server.js` — a single guarded cutover block: the new Notifications router is default;
`NOTIFICATIONS_LEGACY=1` restores the legacy router. No other runtime code changed.

## 4. Mounted Components (carrying traffic)

`notificationsRoutes.js` → `notificationsController.js` → `src/application/notifications/*` →
`src/domain/notifications/*` → ports → `deviceTokenAdapter` (SQL) + `pushGatewayAdapter`
(reuses `notifService`). All 5 endpoints flow Presentation → Application → Domain → Ports →
Infrastructure, no layer skipped.

## 5. Legacy Components Remaining

`src/routes/notifications.js` — **unchanged this phase, unmounted by default.** Provably identical
rollback target (the A/B harness executes it as the "legacy" arm). Dead code pending later retirement.

## 6. Security Report (ADR-007)

| Control | Status | Evidence |
|---|---|---|
| JWT authentication | ✅ preserved | `authenticate` on device-tokens; A/B `*:noauth → 401` |
| Admin RBAC | ✅ preserved | `authenticateAdmin` on push/send, push/broadcast, list; A/B `*:notadmin → 403`, `*:noauth → 401` |
| Ownership / IDOR (delete) | ✅ enforced | delete matches phone+token; missing → silent 200 (info-leak prevention); A/B `delete:missing → 200` |
| Input validation | ✅ in Domain | token required/length, platform allow-list, push required fields, broadcast ≤1000 |
| Rate limiting | ✅ unchanged | global limiter untouched |
| No security regression | ✅ | 21/21 A/B incl. all auth/RBAC/validation scenarios |

## 7. Architecture Compliance Report

Verifier `verify-architecture.mjs`: **PASS, 0 violations**, now scanning **63 enterprise-layer
files** across Identity, Users, Localization, Drivers, Scooters, Notifications. Rules R1–R7 green.
The CI Architecture Gate (Phase 3.6) enforces this on every PR/push. (During development the
verifier correctly **caught** a transient R3 violation — a domain import in the controller — which
was removed before completion; proof the gate works.)

## 8. ADR Compliance Addendum

- **ADR-002:** Notification aggregate + NotificationStatus/Type + DeliveryChannel VOs + Delivery/
  Retry/Read/Visibility policies (pure). → **Impl**
- **ADR-003:** Arabic frozen default (byte-identical); English additive via `Accept-Language`. → **Impl**
- **ADR-004:** device_tokens UPSERT/read via Infrastructure; SQL removed from Presentation. → **Part**
- **ADR-005:** five layers, ports/fail-fast, gates before dispatch, SQL relocated to Infra. → **Impl**
- **ADR-006:** frozen REST/JSON contract, A/B 21/21. → **Part** (events Planned)
- **ADR-007:** §6 above. → **Impl**
- **ADR-008:** layout + DI composition root. → **Impl**
- **ADR-009/010:** unchanged. → **Part**
- **ADR-011 (AI):** N/A · **ADR-012/013/014/015:** governance synced; roadmap advanced; manifesto upheld. → **Impl**

## 9. Updated Traceability Matrix

`architecture/compliance/MATRIX.md` — Notifications row upgraded to `Impl` for ADR-002/003/005/007/008.
Fully ADR-005-compliant contexts now **6/11** (Identity, Users, Localization, Drivers, Scooters,
Notifications).

## 10. Updated Evidence Mapping

`architecture/compliance/EVIDENCE.md` — Notifications rows added (ADR-002/003/005/006/007) pointing at
the new sources, `tests/unit/notifications.test.js`, and `tests/integration/notifications-ab.mjs` (21/21).

## 11. Updated Repository Readiness Report

`architecture/compliance/REPOSITORY-READINESS.md` — Notifications complete; next context under the
enforced gate; Wallet/Payments gated on ADR-001.

## 12. Test Results (executed)

- **Unit:** 116/116 pass (added the Notifications slice; coverage increased).
- **A/B compatibility:** Notifications **21/21 byte-identical** — register (ok/idempotent/no-token/
  bad-platform/too-long/no-auth), delete (existing/missing/no-token/no-auth), push send
  (ok/missing/not-admin/no-auth), broadcast (ok/empty/too-big/not-admin), admin list (ok/no-auth/not-admin).
- **Regression (no existing test failed):** Identity 35 · Users 17 · Drivers 14 · Scooters 24 — all
  still byte-identical.
- **Security tests:** covered by A/B (auth/RBAC/IDOR) + domain unit policies.
- **Architecture:** verifier PASS (63 files). **Lint + Format:** clean (whole tree).

## 13. Rollback Procedure

`NOTIFICATIONS_LEGACY=1` + restart → legacy `src/routes/notifications.js` serves all notification
traffic. Rollback path is live-proven (the harness's legacy arm is exactly rollback mode). No data
migration either way — same `device_tokens` table via the same statements. Full code rollback:
revert the one `server.js` block.

## 14. Technical Debt

1. `src/routes/notifications.js` dead code — retire after a production soak.
2. Read/Visibility policies are modeled here but their runtime surface (notification records) lives in
   the Users context; unify when a dedicated Notifications record store is formalized.
3. Push delivery reuses `notifService` (FCM); broadcast throttling remains a platform-wide debt (M-8).
4. Email/Templates absent by design — enter as new capabilities under a fresh scope if ever built.

## 15. Architecture Drift Report

**Zero drift; net drift reduction.** The verifier passes at 63 files with 0 violations, and this phase
**removed** a pre-existing layering smell (SQL in the notifications route) by relocating it to
Infrastructure. The CI gate blocks any future regression. No layer boundary is crossed by the new code
(mechanically confirmed).

## 16. ADR Coverage Delta (this phase)

| ADR | Before (Notifications) | After (Notifications) |
|---|---|---|
| 002 Domain | Part | **Impl** |
| 003 Global | Part | **Impl** |
| 004 Data | Part | Part (SQL relocated to Infra) |
| 005 App | Part | **Impl** |
| 006 Integ | Part | Part |
| 007 Sec | Part | **Impl** |
| 008 Tech | Part | **Impl** |
| 013/014/015 | Part | **Impl** |

Platform: fully ADR-005-compliant contexts **5 → 6 / 11**.

## 17. Phase 7 Readiness Assessment

**READY.** Notifications is migrated, byte-compatible (21/21), security-preserving, verifier-clean,
CI-gated, instantly reversible, with a net layering improvement; governance artifacts synchronized.
Recommended next: **Admin** (largest remaining surface; RBAC already strong) or **Trips** (highest
value, but touches Commerce invariants — sequence carefully). **Wallet/Payments remain last, gated on
ADR-001.** Phase 7 begins only under an approved bounded-context mandate + A/B plan.

---

*Migration executed under the Strangler Fig pattern. Every PASS is backed by an executed test or a
mechanical check. No legacy behavior changed; no new business feature added; public contracts frozen
and proven byte-identical; a pre-existing layering violation was corrected without behavior change.*
