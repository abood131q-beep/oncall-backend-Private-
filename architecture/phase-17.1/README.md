# Phase 17.1 — OnCall Platform Integration (Platform Adoption)

**Analysis & planning only.** No backend file was modified, no code was generated, no
migration was performed. This folder is the complete integration assessment for running the
existing OnCall backend on top of the Enterprise Platform (ADR-016 → ADR-045) with **full
backward compatibility** — unchanged routes, response formats, DB schema, authentication, and
Socket.IO behavior; Flutter clients continue working without modification.

## Deliverables

| # | Document | Covers |
|---|---|---|
| 00 | [Integration Assessment](00_INTEGRATION_ASSESSMENT.md) | STEP 1 inventory + findings + summary verdict |
| 01 | [Migration Matrix](01_MIGRATION_MATRIX.md) | STEP 2 — per-component current→kernel, difficulty, risk, compat, adapters, wrappers |
| 02 | [Dependency Graph](02_DEPENDENCY_GRAPH.md) | STEP 3 — Backend → Runtime → Platform → Kernels |
| 03 | [Integration Roadmap](03_INTEGRATION_ROADMAP.md) | STEP 4 — small, reversible, testable, additive, zero-downtime sub-phases |
| 04 | [Risk Assessment](04_RISK_ASSESSMENT.md) | STEP 5 — technical/migration/runtime/performance risks + rollback strategy |
| 05 | [Readiness Report](05_READINESS_REPORT.md) | STEP 6 — go/no-go verdict + blockers |
| 06 | [Architecture Diagram](06_ARCHITECTURE_DIAGRAM.md) | Target end-state diagrams (Mermaid) |

## Headline conclusions
- **Verdict: CONDITIONALLY READY.** Begin the additive wrap-and-observe integration now; defer
  all kernel *ownership* of persistent/auth state.
- **The app is not on the Platform yet** — `server.js` has zero references to
  platform/runtime/host/deployment. Integration is greenfield wrapping (lower risk).
- **The Platform is strictly additive** and the repo already has a proven reversible cutover
  mechanism (`*_LEGACY` flags + A/B byte-compat harness) that Phase 17.1 reuses per capability.
- **Two blockers gate ownership (not the start of 17.1):**
  - **B1** — no DB-backed kernel providers (all kernels are memory/file/env/json only).
  - **B2** — no proven Identity token parity vs live Flutter JWTs.
- **Highest-value first step:** wrap the running app as a Host hosted service so the Lifecycle
  kernel owns startup ordering, readiness, health, and graceful shutdown — with no route touched.

## Grounding
Every claim is derived from the actual code in this repository (`server.js`, `src/socket.js`,
`src/middleware/*`, `src/config/*`, `src/routes/*`, `src/presentation/api/*`,
`src/platform/*`, `src/runtime/*`, `src/host/*`, `src/deployment/*`,
`src/application/*/providers/*`) as read on 2026-07-21.
