# Enterprise Architecture Migration — Phase 11 Record (Commerce: Wallet & Payments)

**Pattern:** Strangler Fig · **Authority:** G0.0 · ADR-001 (ratified) · ADR-002…015
**Date:** 2026-07-20 · **Status:** Cutover implemented and A/B-proven (15/15, full wallet lifecycle). Legacy retained behind `COMMERCE_LEGACY=1`.
**Gate:** ADR-001 **ratified 2026-07-20** (Option A+D, already implemented & validated) — authorizing this phase.

---

## 1. Migration Report (summary)

The **Commerce bounded context (Wallet + Payments)** — the platform's money surface and the last
unmigrated context — is migrated into the ADR-005 layered architecture using the proven Strangler
recipe. This phase was **gated on ADR-001 (Financial Consistency / C-1)**, which is now **formally
ratified** with its recommended Option **A+D** — the in-process serialization mutex + the idempotent
completion+payment transaction — both already implemented and validated across Phases 4–10. With the
settlement substrate ratified and proven, Commerce may be migrated with its financial invariants
frozen.

The four Commerce HTTP endpoints lived in the legacy payment router; the new Commerce router now
**owns** them: `GET /payment/methods`, `POST /wallet/charge`, `GET /wallet/transactions/:phone`,
`GET /wallet/balance/:phone`. It is mounted **before** the legacy payment router (first-match =
sole active owner); `COMMERCE_LEGACY=1` restores the legacy handlers instantly. Runtime behavior is
unchanged and the financial contract is frozen — proven byte-identical including the **full charge
lifecycle** (validate → credit → ledger row → notification → balance reflected) with
`PAYMENT_ENABLED=true`.

**Design principle — reuse the money machinery, migrate the decisions.** The Domain owns the
commerce invariants (charge envelope, atomic-deduct sufficiency, wallet-vs-cash settlement, ledger
consistency, one-payment-per-trip idempotency, IDOR ownership). The proven money machinery is
**reused verbatim behind ports**: the atomic `WalletRepository` (source of truth `users.balance`,
the C-3 `deductBalanceSafe`), the `transactions` ledger, the `PAYMENT_ENABLED` gateway posture and
static method catalog, and the notification sender. No SQL, no payment SDK, and no settlement math
is rewritten — so every financial guarantee is preserved exactly.

**Scope migrated:** the four wallet/payment endpoints above (wallet balance, balance queries, wallet
history, payment orchestration/gateway abstraction, transaction validation, payment configuration).
**NOT introduced:** no new provider, no new settlement model, no billing/subscription/promotion
logic, no refund flow (none exists — the `refundPolicy` is a pure, unwired invariant for a future
governed flow). **Reused-in-place (unchanged):** the trip-settlement path
(`PaymentService.processPayment`) stays inside the ADR-001 serialized completion transaction via the
Trips `completionGateway`; the `/fare/*` pricing endpoints stay in the legacy payment router (pricing
is Trips-owned, not Commerce). The Users-context `/balance/*` and `/transactions/*` reads were already
migrated under ADR-005 in Phase 3 and reuse the same wallet repository.

## 2. Files Created (10)

**Domain (pure):** `src/domain/commerce/commerceValues.js` · `commercePolicies.js` · `Commerce.js`
**Application:** `src/application/commerce/ports.js` · `commands.js` · `useCases.js` · `index.js`
**Infrastructure:** `src/infrastructure/repositories/commerceRepositoryAdapter.js` ·
`src/infrastructure/gateways/commerceGateways.js`
**Presentation:** `src/presentation/api/commerceController.js` · `commerceRoutes.js`
**Tests:** `tests/unit/commerce.test.js` · `tests/integration/commerce-ab.mjs`

*(Domain/Application/Infra/Presentation = 10 source files; plus 2 test files.)*

## 3. Files Modified (2)

- `server.js` — one guarded cutover block (before the legacy payment mount): the new Commerce router
  is default; `COMMERCE_LEGACY=1` restores the legacy payment handlers. The legacy payment router
  stays mounted after it (serving `/fare/*` always + the 4 wallet paths only in rollback).
- `docs/ADR-001-transaction-concurrency.md` — **ratification record** added (Status → RATIFIED,
  Option A+D), documenting the gate that authorizes this phase.

## 4. Mounted Components (carrying traffic)

`commerceRoutes.js` → `commerceController.js` → `src/application/commerce/*` →
`src/domain/commerce/*` → ports → `commerceRepositoryAdapter` (wallet + ledger) +
`commerceGateways` (payment/notification/audit). Reuses `WalletRepository`, `userRepo`, the
`transactions` ledger, `PAYMENT_ENABLED`, `notifRepo`, and `logger`.

## 5. Legacy Components Remaining

`src/routes/payment.js` — **unchanged, still mounted.** Its four wallet/payment endpoints are shadowed
by the Commerce router (first-match; retained as the provably-identical `COMMERCE_LEGACY=1` rollback
target — the A/B harness runs it as the "legacy" arm). Its `/fare/*` pricing endpoints remain active
and owned there (out of Commerce scope). `PaymentService` remains the reused settlement engine for
Trips completion. Retire the shadowed wallet handlers after a production soak.

## 6. Security Report (ADR-007 + ADR-001)

| Control | Status | Evidence |
|---|---|---|
| JWT authentication | ✅ preserved | `authenticate` on charge/transactions/balance; A/B `charge:noauth → 401` |
| Ownership / IDOR | ✅ preserved | `ownershipPolicy` (path phone == JWT phone); A/B `balance:idor`/`txns:idor → 403` (+ unit) |
| Charge-envelope validation | ✅ preserved | `paymentValidationPolicy` (0 < amount ≤ 500); A/B `charge:zero/over/neg → 400` |
| Idempotency (one payment/trip) | ✅ preserved | `idempotencyPolicy` (unit) + the ADR-001 serialized completion transaction (reused, unchanged) |
| Ledger consistency | ✅ preserved | `ledgerConsistencyPolicy` (credit/debit/cash reconciliation, unit) + atomic `deductBalanceSafe` reused |
| Transaction integrity (atomic deduct) | ✅ preserved | `deductBalanceSafe` reused verbatim (C-3); no race window |
| Replay/double-charge protection | ✅ preserved | ADR-001 A+D: serialized completion ⇒ exactly one `trip_payment` row per trip |
| Gateway posture | ✅ preserved | `PAYMENT_ENABLED=false ⇒ 503 PAYMENT_GATEWAY_UNAVAILABLE` (reused; unit) |
| Rate limiting | ✅ unchanged | global limiter untouched |
| No security regression | ✅ | 15/15 A/B incl. full lifecycle + all auth/IDOR/validation scenarios |

## 7. Architecture Compliance Report

Verifier: **PASS, 0 violations**, now scanning **116 enterprise-layer files** across eleven contexts
(domain 31 · application 41 · infrastructure 26 · presentation 18). Rules R1–R7 green: no
framework/SQL/payment-SDK in Domain/Application, presentation imports no Domain, controller imports
no Infra/DB, Domain pure, Application downward-only, no cycles, ports asserted. The CI Architecture
Gate enforces this on every PR/push.

## 8. ADR Compliance Addendum

- **ADR-001 (Commerce / C-1):** **ratified** (Option A+D); settlement invariants frozen; Commerce
  migrated under the ratified substrate. → **Ratified / Impl**
- **ADR-002:** Wallet/Payment/Transaction aggregates + Money/Currency/PaymentMethod/PaymentStatus/
  WalletId/PaymentId/TransactionId VOs + 6 policies (pure). → **Impl**
- **ADR-003:** Arabic frozen default (byte-identical); English additive via `Accept-Language`
  (charge validation + messages). A/B `charge:zero:ar-header` parity. → **Impl**
- **ADR-004:** `users.balance` + `transactions` ledger reused verbatim behind adapters; append-only
  ledger practice preserved. → **Part** (Postgres cutover Planned)
- **ADR-005:** four layers, ports/fail-fast, gates before domain, thin controller. → **Impl**
- **ADR-006:** frozen REST/JSON contract across all 4 endpoints; A/B 15/15. → **Part**
- **ADR-007:** §6 above. → **Impl**
- **ADR-008:** layout + DI composition root; envelope/validation outside persistence. → **Impl**
- **ADR-009/010:** unchanged; audit feeds the existing observability fabric. → **Part**
- **ADR-011:** the fare/settlement automations remain classified & fallback-guarded (Phase 10). → **Impl**
- **ADR-012/013/014/015:** governance synced; roadmap complete; manifesto upheld. → **Impl**

## 9. Updated Traceability Matrix

`architecture/compliance/MATRIX.md` — Wallet & Payments rows upgraded to `Impl` for
ADR-002/003/005/007/008; ADR-001 recorded as ratified. Fully ADR-005-compliant contexts now
**11/11** — the migration program is complete.

## 10. Updated Evidence Mapping

`architecture/compliance/EVIDENCE.md` — Commerce rows added (ADR-001/002/003/005/007) pointing at
the new sources, `tests/unit/commerce.test.js` (incl. ledger-consistency + idempotency), and
`tests/integration/commerce-ab.mjs` (15/15, full lifecycle).

## 11. Updated Repository Readiness Report

`architecture/compliance/REPOSITORY-READINESS.md` — Commerce complete; **no legacy business context
remains**; the ADR-005 migration program is closed (see §17).

## 12. Test Results (executed)

- **Unit:** 180/180 pass (added the 15-case Commerce slice, incl. explicit **ledger-consistency**
  and **idempotency** tests; coverage increased).
- **A/B compatibility:** Commerce **15/15 byte-identical** — methods catalog, balance/history
  (empty + after settlement, exact figures), IDOR (403), charge validation (400s), and the **full
  charge lifecycle** (credit + ledger row + notification, balance reflected) under `PAYMENT_ENABLED=true`.
- **Ledger-consistency & idempotency:** proven at the domain level (unit) and at runtime by the
  reused ADR-001 serialized completion (the C-1 race re-tests: double-complete ⇒ one 200 + one clean
  4xx, exactly one wallet deduction, one `trip_payment` row — validated across phases; the Trips A/B
  exercises the completion+payment path).
- **Regression (no existing test failed):** Identity 35 · Users 17 · Drivers 14 · Scooters 24 ·
  Trips 31 · Notifications 21 · Admin 43 · Fleet 14 · AI 16 — all still byte-identical (230 A/B
  scenarios total).
- **Architecture:** verifier PASS (116 files). **Lint + Format:** clean (whole tree).

## 13. Rollback Procedure

`COMMERCE_LEGACY=1` + restart → the legacy payment router serves all four wallet/payment endpoints.
Rollback path is live-proven (the harness's legacy arm is exactly rollback mode). No data migration —
same `users.balance` + `transactions` tables via the same atomic repository. Independent of
`TRIPS_LEGACY` (settlement stays reused). Full code rollback: revert the one `server.js` block.

## 14. Technical Debt

1. The shadowed wallet handlers in `src/routes/payment.js` are dead when Commerce is active — retire
   after a production soak.
2. The trip-settlement engine (`PaymentService.processPayment`) is reused by Trips; routing it through
   the Commerce application's settlement use case (so all settlement flows one path) is a
   behavior-preserving follow-up, deliberately deferred to avoid touching the C-1-critical completion.
3. A real payment gateway (K-Net/Visa/Apple Pay) is a future, separately-governed integration — the
   `paymentGateway` port is the seam; the disabled posture (`PAYMENT_ENABLED`) is preserved today.
4. `users.balance` + `transactions` reused verbatim — the natural home for the ADR-004 Postgres
   ledger cutover (ADR-001 Option E, roadmap).
5. The `wallets` table exists for a future separate-wallet model (unused today, per WalletRepository).

## 15. Architecture Drift Report

**Zero drift.** Verifier passes at 116 files with 0 violations; the CI gate blocks any regression.
The platform's most sensitive surface — money movement — now flows through clean layers with the
financial decisions in a pure Domain and every money integration reused behind ports; the atomic
deduct, the ledger, and the ADR-001 serialized settlement are untouched. No boundary is crossed by
the new code (mechanically confirmed).

## 16. ADR Coverage Delta (this phase)

| ADR | Before (Commerce) | After (Commerce) |
|---|---|---|
| 001 Commerce | Proposed (gate) | **Ratified** |
| 002 Domain | Part | **Impl** |
| 003 Global | Plan | **Impl** |
| 005 App | Plan | **Impl** |
| 007 Sec | Part | **Impl** |
| 008 Tech | Part | **Impl** |
| 013/014/015 | Plan/Part | **Impl** |

Platform: fully ADR-005-compliant contexts **10 → 11 / 11** — **complete**.

## 17. Enterprise Migration Completion Report

**The ADR-005 migration program is COMPLETE.** All eleven planned bounded contexts are migrated to
the enterprise layered architecture, each proven byte-identical to its legacy behavior, each behind
an immediate rollback switch, under a permanent, CI-enforced governance gate.

**Contexts migrated (11/11):**

| Phase | Context | Rollback switch | A/B proof |
|---|---|---|---|
| 2 | Identity | `IDENTITY_LEGACY` | 35/35 |
| 3 | Users (+ Localization) | `USERS_LEGACY` | 17/17 |
| 4 | Drivers | `DRIVERS_LEGACY` | 14/14 |
| 5 | Scooters | `SCOOTERS_LEGACY` | 24/24 |
| 6 | Notifications | `NOTIFICATIONS_LEGACY` | 21/21 |
| 7 | Trips | `TRIPS_LEGACY` | 31/31 |
| 8 | Admin | `ADMIN_LEGACY` | 43/43 |
| 9 | Fleet | `FLEET_LEGACY` | 14/14 |
| 10 | AI / Automation | `AI_LEGACY` | 16/16 (zero-drift) |
| 11 | Commerce (Wallet + Payments) | `COMMERCE_LEGACY` | 15/15 |

**Program-level guarantees, all mechanically enforced:**
- **Runtime behavior unchanged** — 230 A/B scenarios byte-identical across all contexts.
- **Public contracts frozen** — every endpoint's status/JSON/key-order/messages preserved; Arabic
  byte-identical, English additive-only (ADR-003).
- **Architecture clean** — verifier PASS at 116 enterprise files, 0 violations (R1–R7), enforced by
  the CI Architecture Gate on every PR/push.
- **Tests green** — 180 unit tests; ledger-consistency, idempotency, and C-1 concurrency proven.
- **Immediate rollback** — every context reverts via a single env switch to a live-proven legacy arm.
- **Governance synchronized** — MATRIX (11/11), EVIDENCE, REPOSITORY-READINESS, and 11 phase records
  all current; ADR-001 ratified.
- **No new business capability introduced** in any phase — pure structural migration.

**Standing items (roadmap, not blockers):** the ADR-004 PostgreSQL cutover (ADR-001 Option E),
scale-out infrastructure (Redis Socket.IO adapter, `prom-client` exposition), and the retirement of
the now-shadowed legacy routers after production soak. A real payment gateway and any future AI model
provider remain separately-governed integrations with their seams already in place.

The OnCall Global Mobility Platform now runs entirely on the ADR-005 enterprise architecture, with
every bounded context layered, tested, reversible, and governed.

---

*Migration executed under the Strangler Fig pattern. Every PASS is backed by an executed test or a
mechanical check. No legacy behavior changed; no new financial feature added; public contracts frozen
and proven byte-identical including the full wallet lifecycle; ledger consistency and idempotency
preserved; the money machinery reused, not reimplemented. ADR-001 ratified; the migration program is
complete.*
