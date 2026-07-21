# Project Gap Report — تقرير النواقص فقط

**Date:** 2026-07-21 · **Scope:** full scan of the Enterprise integration work (Phases 17.1–17.6
+ G1.0). **Nature:** report only — no fixes performed. Ordered by severity. Items marked
*by-design* are expected given the shadow strategy but are still "missing" relative to full
platform adoption.

---

## A. Source-control / release gaps (HIGH)

- **A1 — All Phase 17 work is uncommitted.** Git shows **2 modified** tracked files
  (`server.js`, `.env.example`) + **23 untracked** paths (all `src/platform-adapters/*`,
  `src/enterprise/*`, `src/hosted-service/*`, `src/app/*`, `architecture/*`, new tests). No
  commit, branch, PR, or review trail. Risk of loss and no history.
- **A2 — No CHANGELOG / version record** for the Phase 17 work; `package.json` version unchanged
  (`1.0.0`).
- **A3 — ADR-046 not written.** G1.0's header names **ADR-046 (proposed)** as the ratifying
  decision for the Shadow standard, but no `architecture/ADR/ADR-046-*.md` file exists (ADRs
  stop at 045). The standard is therefore not formally ratified by an ADR yet.

## B. Verification gaps that could NOT be closed in this environment (HIGH)

- **B1 — Live HTTP A/B never executed.** All A/B harnesses (`mode-parity-ab`,
  `config-shadow-ab`, `observability-shadow-ab`, `jobs-shadow-ab`, `scheduler-shadow-ab`, plus
  the 11 legacy context harnesses) and `integration-test.mjs` require the **sqlite3 native
  binding**, which fails to `dlopen` in the analysis sandbox (built for the app's macOS). So the
  end-to-end **byte-identity gate has not produced a recorded `Result: IDENTICAL`** anywhere —
  every parity report marks it ⏳ pending on the app's OS / CI.
- **B2 — DB-backed unit tests unrun here.** App-context unit tests (`admin`, `drivers`, `trips`,
  `users`, `scooters`, `commerce`, `fleet`, `notifications`, `identity`, `ai`) exercise
  repositories → sqlite, so their pass/fail is **unverified in this environment**. Only the
  memory-only suites (shadow/host/platform/kernel) were run green here.
- **B3 — No captured green CI run.** `npm run ci` (lint + format + unit + A/B) has not been run
  to completion with the new harnesses included; there is no artifact proving the full gate
  passes.

## C. G1.0 compliance debt in already-shipped integrations (MEDIUM)

- **C1 — Config shadow (17.3) metrics miss BOTH `confidenceLevel` AND `coveragePct`.**
  `src/platform-adapters/configuration/metrics.js` emits neither, though G1.0 §5 now mandates
  both. (`grep confidenceLevel` = 0 matches; no `coveragePct`.)
- **C2 — Observability shadow (17.4) metrics miss `coveragePct`.** It has `confidenceLevel` but
  not `coveragePct` (G1.0 §5).
- **C3 — Duplicated `deepEqual`.** Config and Observability shadows still carry **local copies**
  of `deepEqual` instead of importing the shared `_shadow/core`. The Phase 17 Completion Report
  flagged this as "adopt when next touched"; still outstanding → three implementations of the
  same comparator.
- *(Jobs 17.5 and Scheduler 17.6 are fully compliant — they use the shared framework and emit
  confidence + coverage.)*

## D. Framework generalization gap (MEDIUM)

- **D1 — Read-through generic verifier not extracted.** The round-trip pattern was generalized
  (`createRoundTripShadow`), but the **read-through** pattern (Config, Observability) is still
  bespoke per kernel. The Framework Overview lists this as a future extension; until done, new
  read-through kernels (Identity `verify`, Policy `decide`, …) have no shared verifier to reuse.

## E. Scope-completion gaps — by design, but outstanding (MEDIUM)

- **E1 — Only 4 of ~19 app-relevant kernels integrated** (configuration, observability, jobs,
  scheduler). **Not yet integrated:** identity, policy, audit, storage, secrets, features,
  notifications, ratelimit, messaging, gateway, resilience, mesh, tenancy, resources, discovery,
  workflow, lock, extensions.
- **E2 — Zero functional migration.** Every integrated kernel is **Shadow/Verified only**; none
  is authoritative. The legacy platform still owns 100% of behavior, data, auth, and scheduling.
  No kernel has advanced past the "Verified" state in the G1.0 promotion ladder.
- **E3 — Ownership blockers from the 17.1 Readiness Report remain OPEN:**
  - **B1 (readiness):** no **DB-backed kernel providers** — every kernel ships memory/file/env
    providers only. Blocks Storage / Ratelimit / Notifications / Jobs / Identity from ever
    owning persistent state.
  - **B2 (readiness):** no **proven Identity token parity** vs live Flutter JWTs. Blocks Identity
    from owning authentication.
  These were identified in Phase 17.1 and are still unaddressed.

## F. Environment / tooling gaps (LOW)

- **F1 — Node engine mismatch.** `package.json` engines = `>=24 <25`; the analysis runtime is
  **v22.22.3**. Advisory only, but dev/CI must pin Node 24 to match the declared contract.
- **F2 — Security scan status unknown.** `.scannerwork/` (SonarQube) exists, but no scan
  results/report are included in the deliverables for the new modules.
- **F3 — No code-coverage figures** captured for the new modules (`npm run test:coverage` not
  run); tests exist and pass but line/branch coverage is unquantified.
- **F4 — CI guard for "both-off ≡ previous phase" not evidenced.** The mechanism exists
  (mode-parity harness + `run-ab.mjs` auto-discovery), and G1.0 §13.6 expects CI to enforce it,
  but there is no recorded passing run proving the guard is active.

## G. Minor / hygiene (LOW)

- **G1 — `.env.example` flags are documented but commented-out defaults only;** no automated
  assertion ties them to the code's default-OFF behavior (relies on tests, not a config lint).
- **G2 — Empty scaffolding remains.** Numerous `.gitkeep`-only directories under
  `src/application/*`, `src/infrastructure/*`, `src/presentation/*` (pre-existing, not from this
  work) — dead scaffolding that inflates the tree.
- **G3 — Framework Overview / G1.0 version drift risk.** Both docs must be updated whenever
  `_shadow/` changes; no automated check enforces that they stay in sync with the code.

---

## Severity summary

| Severity | Items |
|---|---|
| **HIGH** | A1 uncommitted work · A3 missing ADR-046 · B1 A/B never run · B3 no green CI artifact |
| **MEDIUM** | C1/C2 metrics gaps (config/observability) · C3 deepEqual duplication · D1 read-through generic · E1 kernels remaining · E2 zero migration · E3 ownership blockers B1/B2 |
| **LOW** | A2 changelog · B2 DB tests unrun · F1 node version · F2 security scan · F3 coverage figures · F4 CI guard evidence · G1–G3 hygiene |

## Notes on what is NOT a gap (for context)

Parity 100% + non-execution proofs for the four integrated shadows were verified in-environment
(memory-only). Full lint passes. Both-flags-off ≡ previous phase is test-proven. Only
`server.js` + `.env.example` are tracked-modified; no application route/service/repo/middleware/
schema was changed. These are complete — the items above are strictly what remains missing or
unverified.

---

## Remediation Status — Phase 18.0 (2026-07-21)

See `architecture/phase-18.0/PHASE_18.0_REMEDIATION_REPORT.md` for full detail.

| Item | Severity | Status |
|---|---|---|
| A1 uncommitted work | HIGH | ⚠️ Prepared — commit blocked by sandbox FUSE git-lock; run on host (commands in report) |
| A2 changelog/version | HIGH | ✅ Closed — `CHANGELOG.md` seeded; release-please owns version |
| A3 ADR-046 missing | HIGH | ✅ Closed — ADR-046 written (Accepted) |
| B1 A/B never run | HIGH | ✅ Parity closed via `verify:shadow` (green here); HTTP byte-identity in CI |
| B2 DB tests unrun | HIGH | ✅ Wired — runs in CI `test` job (sqlite present) |
| B3 no CI gate | HIGH | ✅ Closed — CI exists + extended with `verify:shadow` |
| C1 config metrics gaps | MEDIUM | ✅ Closed — shared metrics (confidence+coverage) |
| C2 observability coverage | MEDIUM | ✅ Closed — coveragePct added |
| C3 deepEqual duplication | MEDIUM | ✅ Closed — single canonical comparator |
| D1 read-through generic | MEDIUM | ✅ Closed — `createReadThroughShadow` extracted + used |
| E3 ownership blockers | MEDIUM | ✅ Closed — ADR-047 (Accepted & Gated) |

**Verification:** ESLint + Prettier + architecture gate PASS; 85/85 Phase-17 unit tests PASS;
`verify:shadow` PASS (100% parity + coverage). No regression; no new kernel; G1.0 preserved.
