# G0.0 — OnCall Evolution Strategy: Existing Platform → Global Mobility Platform

**Status:** Proposed · **Author:** Principal Engineering · **Date:** 2026-07-18
**Prime directive:** evolve in place. Nothing rebuilt, nothing discarded without a named architectural reason.

---

## 1. Current Platform Assessment

Verified by full-repository indexing and six phases of hands-on engineering (P7-01…P7-06):

**Strong and production-grade (protect these investments):**
- Backend: Express 5, ~8,100 LOC, 98 endpoints, clean layering (routes → services → repositories) with **constructor-injected dependencies** (`createXRepository({dbGet,dbAll,dbRun})`, `createXService(svc)`) — this DI seam is the single most valuable architectural asset for migration.
- Flutter app: 35 Dart files, 13 screens, centralized `api_service`/`session_service`/`socket_service`, config via `--dart-define` — API consumption is already funneled through 3 files.
- Security posture: JWT + refresh rotation + revocation store, RBAC, OTP gate, rate limiting, P6-04 production guards.
- Infrastructure (P7): hardened multi-arch signed images, 4-service compose with TLS edge, full observability, encrypted tested backup/DR (RPO≤15 m), CI/CD with progressive deploy + auto-rollback. **Meets enterprise standards — per the rules, not to be replaced.**
- MCP tooling: 101 tools mirroring the API.

**Known structural debts (all previously documented, none fixed by stealth):**
- 🔴 **C-1: concurrent trip completion → financial inconsistency** (ADR-001 written, awaiting approval — still open, still the release blocker).
- SQLite single-writer; in-memory rate-limit/cache/revocation stores (single-process); H-1 toggle ambiguity; H-2 missing app socket listeners; M-3 contract triplication; M-5 no scrapeable metrics; H-3 no Flutter CI; Arabic strings hardcoded (i18n debt for "global").

## 2. Components To Keep (unchanged)

REST API contract (paths + response shapes — **frozen**, mobile releases lag deploys); Socket.IO event names/payloads (frozen); auth semantics; Flutter UI/screens; repository/service layering; the entire P7 infrastructure stack (Docker, nginx gateway, Prometheus/Grafana, backup/DR, CI/CD); MCP server; SQLite **as interim store** until G3.

## 3. Components To Refactor (in place, behind existing seams)

1. **`dbTransaction` + trip-completion boundary** — ADR-001 A+D. *Precondition for everything else.*
2. **State stores → Redis** (already provisioned): `rateLimiter`, `cache`, revocation store each sit behind their own module interface with `init*()` loaders — swap internals, zero API change. Unlocks multi-instance + canary-consistent revocation.
3. **Metrics (M-5):** add prom-client exposition on the internal network — small additive change.
4. **`admin.js` (865 lines) / `admin_dashboard.dart` (1,252 lines):** split only when next touched — no big-bang refactor.
5. **App socket listeners (H-2)** + **toggle decision (H-1)** — small, contract-compatible.

## 4. Components To Replace Later (with named reasons)

| Component | Replacement | When | Reason |
|---|---|---|---|
| SQLite | PostgreSQL (already provisioned + backed up + monitored) | G3 | single-writer ceiling; the root of C-1's class of defects; prerequisite for multi-city scale |
| In-proc Socket.IO state | Socket.IO Redis adapter | G5 | horizontal scale-out of realtime |
| Single-host compose | (explicitly deferred — K8s/multi-region were ruled out of scope by prior directive) | post-G5 | only when load proves it |
| `driverMatcher` proximity scan | PostGIS query | G3+ | geo-indexing at city scale |

**Nothing in the Flutter app is scheduled for replacement.**

## 5. Incremental Migration Plan (zero downtime, no rewrite)

Every step ships through the existing P7-06 pipeline (canary + auto-rollback) and is env-flag reversible.

- **G1 — Stabilize (1–2 wks):** C-1 fix (ADR-001 A+D) → H-1 decision → H-2 listeners → M-5 metrics → Flutter CI (H-3). Exit: race tests green, CI fully green, business metrics visible.
- **G2 — Externalize state (1–2 wks):** rate-limit/cache/revocation → Redis behind unchanged interfaces; flag `STATE_BACKEND=memory|redis`, instant rollback. Exit: backend restart loses no limiter/revocation state.
- **G3 — PostgreSQL migration (3–4 wks), zero-downtime pattern:**
  1. Repository seam: same SQL surface behind a driver adapter (SQLite dialect kept).
  2. **Shadow-write**: write both stores, read SQLite; nightly row-count/checksum diff jobs (infra exists in the backup agent).
  3. Verification window ≥1 wk of clean diffs under real traffic.
  4. **Read cutover** behind `DB_BACKEND=postgres` — deployed as canary; rollback = flag flip (SQLite still receiving writes).
  5. Retire SQLite writes; SQLite demoted to the DR fallback for one release; existing pg_dump backup path (P7-05) becomes primary.
- **G4 — Platform features (4–6 wks, additive only):** OpenAPI contract + contract tests (kills M-3 triplication without codegen rewrites); `city_id`/config-per-city model (additive columns, PG migrations); i18n extraction (backend message catalog + Flutter arb — mechanical, screen-by-screen); pricing/fare as per-city config (fareCalculator already config-driven).
- **G5 — Scale-out (2–3 wks):** Socket.IO Redis adapter, backend replicas behind the existing nginx upstream (the weighted-upstream machinery from canary generalizes), true parallel blue/green (unlocked by PG).

**How Flutter avoids a rewrite:** the API contract is frozen; new capabilities are additive endpoints; OpenAPI is used for *contract testing*, not client regeneration; i18n and screen refactors happen opportunistically per screen; `baseUrl`/feature exposure already externalized via dart-define + server responses.

## 6. Risks

1. **C-1 remains unfixed while strategy work continues** — a live financial-consistency defect outranks every roadmap item. (Escalated again here.)
2. Shadow-write divergence (dialect drift SQLite↔PG) — mitigated by the adapter keeping one SQL surface + diff jobs + long verification window.
3. Mobile release lag — mitigated by the frozen-contract rule and additive-only changes.
4. Scope temptation: "global platform" pressure to rewrite into microservices — **rejected**; modular monolith until data + realtime layers are externalized and load says otherwise.
5. Single-maintainer bus factor — mitigated partially by runbooks/ADRs; unresolved.

## 7. Estimated Migration Timeline

G1 1–2 wks → G2 1–2 wks → G3 3–4 wks → G4 4–6 wks → G5 2–3 wks.
**Total ≈ 11–17 weeks**, each phase independently shippable and stoppable; the platform is fully operational at every intermediate state.

## 8. Final Recommendation

Evolve in place. The codebase's DI seams, frozen API contract, and already-provisioned Postgres/Redis + enterprise infra mean the "global" ambition is reachable through five bounded, reversible phases with zero rewrites and zero planned downtime. **First action: approve ADR-001 (A+D) and execute G1 — no strategy survives contact with an open financial-consistency bug.**

---

**G0.0 — EVOLUTION STRATEGY CERTIFIED** (as a design artifact; implementation certification occurs per phase).
