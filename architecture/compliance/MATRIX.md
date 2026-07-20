# Architecture Traceability Matrix — Bounded Context × ADR

**Repository state after Phase 11 (Commerce Migration) — MIGRATION PROGRAM COMPLETE (11/11)** · **Date:** 2026-07-20
**Legend:** `Impl` = Implemented · `Part` = Partial · `Plan` = Planned · `N/A` = Not Applicable

Every cell is defined. "Impl" means realized under the ADR-005 layered architecture with
compatibility proof; "Part" means some capability exists (often legacy or forward-provisioned)
but not fully ADR-conformant; "Plan" means named on the roadmap, not started; "N/A" means the
ADR does not govern that context.

The migrated enterprise contexts are **Identity** (Phase 2), **Users** (Phase 3), **Drivers**
(Phase 4), **Scooters** (Phase 5), **Notifications** (Phase 6), **Trips** (Phase 7), **Admin**
(Phase 8), **Fleet** (Phase 9), **AI / Automation** (Phase 10, ownership-establishment), and
**Commerce — Wallet + Payments** (Phase 11, authorized by the ratified ADR-001); **Localization**
(cross-cutting, ADR-003) landed with Users. **The ADR-005 migration program is complete: all 11
bounded contexts are migrated** — no business context remains on the legacy monolith. Legacy routers
are retained solely as instant-rollback targets behind their `*_LEGACY` switches (G0.0).

| Context \ ADR | 002 Domain | 003 Global | 004 Data | 005 App | 006 Integ | 007 Sec | 008 Tech | 009 Deploy | 010 Obsv | 011 AI | 012 Gov | 013 Road | 014 Ref | 015 Manif |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **Identity** | Impl | Part | Part | Impl | Part | Impl | Impl | Part | Part | N/A | Impl | Impl | Impl | Impl |
| **Users** | Impl | Impl | Part | Impl | Part | Impl | Impl | Part | Part | N/A | Impl | Impl | Impl | Impl |
| **Localization** | Impl | Impl | Part | Impl | N/A | N/A | Impl | Part | N/A | N/A | Impl | Impl | Impl | Impl |
| **Drivers** | Impl | Impl | Part | Impl | Part | Impl | Impl | Part | Part | N/A | Impl | Impl | Impl | Impl |
| **Scooters** | Impl | Impl | Part | Impl | Part | Impl | Impl | Part | Part | N/A | Impl | Impl | Impl | Impl |
| **Trips** | Impl | Impl | Part | Impl | Part | Impl | Impl | Part | Part | N/A | Impl | Impl | Impl | Impl |
| **Fleet** | Impl | Impl | Part | Impl | Part | Impl | Impl | Part | Part | N/A | Impl | Impl | Impl | Impl |
| **Wallet** | Impl | Impl | Part | Impl | Part | Impl | Impl | Part | Part | N/A | Impl | Impl | Impl | Impl |
| **Payments** | Impl | Impl | Part | Impl | Part | Impl | Impl | Part | Part | N/A | Impl | Impl | Impl | Impl |
| **Notifications** | Impl | Impl | Part | Impl | Part | Impl | Impl | Part | Part | N/A | Impl | Impl | Impl | Impl |
| **AI** | Impl | Impl | Part | Impl | Part | Impl | Impl | Part | Part | Impl | Impl | Impl | Impl | Impl |
| **Admin** | Impl | Impl | Part | Impl | Part | Impl | Impl | Part | Part | N/A | Impl | Impl | Impl | Impl |

## Cell rationale (key entries)

- **Identity / Users → ADR-005 = Impl:** full Domain/Application/Infrastructure/Presentation
  layering, verifier R1–R7 pass, A/B byte-identical (35/35, 17/17).
- **Users → ADR-003 = Impl:** Locale VO + message catalog + `Accept-Language` negotiation wired;
  default `ar` byte-identical, `en` additive.
- **Drivers → ADR-002/005/008 = Impl:** pure Driver aggregate/value objects/policies, ports,
  adapters, and controllers are mounted behind `DRIVERS_LEGACY=1` rollback; A/B 14/14 is
  byte-identical for the existing HTTP surface.
- **Drivers → ADR-003 = Impl:** Arabic remains the default frozen response language; English
  rejection messages are additive through `Accept-Language` and do not alter Arabic output.
- **Identity → ADR-003 = Part:** Arabic strings still hardcoded in the Identity controller
  (localization not yet extended there — documented debt).
- **\* → ADR-004 = Part:** append-only transactions, approval audit logs, and JWT revocation
  records already practice the facts/immutability instinct; formal data-class governance and
  the Postgres cutover are Planned (Postgres is forward-provisioned in `docker-compose.prod.yml`,
  not yet consumed).
- **\* → ADR-009 = Part:** Dockerfile, `docker-compose.prod.yml` (postgres/redis provisioned),
  nginx TLS edge, backup compose, and 6 CI/CD workflows exist repository-wide; not per-context
  and app not yet consuming postgres/redis.
- **\* → ADR-010 = Part:** `/health` (db/memory/event-loop) + in-process metrics middleware +
  monitoring compose (Prometheus/Grafana) exist; scrapeable `prom-client` exposition (M-5) absent.
- **AI → ADR-002/003/005/007/008/011 = Impl** (Phase 10, ownership-establishment): no production
  model runtime exists, so the AI/Automation context is established as the official ADR-005 owner of
  the platform's existing deterministic automations (dispatch matching, rule-based fare,
  auto-rollback — all classified **D3** with mandatory fallbacks per ADR-011 §4/§8). Pure Domain
  (5 policies: provider-selection/prompt-validation/safety/routing/audit); a **disabled** provider
  adapter (infer never invoked); audit reused via the existing logger. Dormant — no HTTP route, no
  inference call — behind `AI_LEGACY=1`; **16/16 zero-drift A/B** proves registering it changes
  nothing. Wallet/Payments untouched pending ADR-001 (ADR-011 §10 C-1).
- **All contexts → ADR-012 = Impl:** this Phase-3.5 governance layer (verifier + this matrix +
  ADR compliance docs + evidence + rules) applies to every context uniformly.
- **Legacy contexts → ADR-007 = Part:** JWT/RBAC/OTP/rate-limit/revocation protect them via the
  shared middleware, but they are not yet re-expressed under the ADR-005 gates model. **Admin →
  ADR-002/003/005/007/008 = Impl** (Phase 8): the general admin surface now runs through pure
  Domain policies (RBAC / pagination & clamp / taxi validity / restore & shutdown guards / audit)
  behind `ADMIN_LEGACY=1` rollback; A/B 43/43 byte-identical; `authenticateAdmin` on every route.
- **Fleet → ADR-002/003/005/007/008 = Impl** (Phase 9): the three vehicle-inventory endpoints —
  previously co-located in Trips (`GET /taxis`) and Admin (`POST/DELETE /admin/taxis`) — are
  extracted into a Fleet context that now owns them, mounted ahead of Trips/Admin, behind
  `FLEET_LEGACY=1` rollback; pure Domain (registration/validation/availability/assignment policies +
  sanitized projection); A/B 14/14 byte-identical; two prior co-location debts retired.
- **Wallet / Payments → ADR-001/002/003/005/007/008 = Impl** (Phase 11): **ADR-001 ratified**
  (Option A+D, implemented & validated) opened the gate; the four wallet/payment endpoints
  (`/payment/methods`, `/wallet/charge`, `/wallet/transactions/:phone`, `/wallet/balance/:phone`) are
  extracted from the legacy payment router into a Commerce context that now owns them, behind
  `COMMERCE_LEGACY=1` rollback; pure Domain (Wallet/Payment/Transaction aggregates + 6 policies incl.
  ledger-consistency & idempotency); the atomic `WalletRepository`, the ledger, and the ADR-001
  serialized settlement are reused verbatim; A/B 15/15 byte-identical incl. the full charge lifecycle.
  **This completes the ADR-005 migration program (11/11).**
- **ADR-013 / ADR-014 / ADR-015** govern the platform as a whole; migrated contexts are `Impl`
  (they follow the roadmap, appear in the reference architecture, obey the manifesto), legacy
  contexts are `Part` (they obey the manifesto's "evolve in place / freeze contracts" but await
  their roadmap slot).

## Coverage summary

- Fully ADR-005-compliant contexts: **11 / 11** — **migration program COMPLETE** (Identity, Users, Localization, Drivers, Scooters, Notifications, Trips, Admin, Fleet, AI, Commerce/Wallet+Payments).
- Contexts under legacy (kept running, contract-frozen): **0 / 11** — legacy routers retained only as instant-rollback targets behind `*_LEGACY` switches.
- ADR-001 (Commerce/C-1): **RATIFIED** (2026-07-20, Option A+D — implemented & validated).
- Governance (ADR-012) coverage: **11 / 11** (this layer is platform-wide).
- No cell is undefined.
