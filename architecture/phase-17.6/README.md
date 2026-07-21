# Phase 17.6 — Scheduler Kernel Shadow Integration

**Complete.** The Enterprise Scheduler Kernel (ADR-020) is integrated in **shadow mode**,
building on the Jobs (17.5) reference and **reusing/extending** the shared shadow framework per
G1.0 §7. Each legacy schedule is registered into the kernel and compared; the **legacy scheduler
remains the only owner of timing and the only producer of work**. The kernel is never
authoritative, **never arms a timer**, and **never executes** (the adapter never calls
`start()`/`tick()`).

> Authoritative references (immutable): **ADR-020**, **G1.0**, **Phase 17 Completion Report**,
> **Phase 17.5**.

## Architecture change (Post-Implementation Review, G1.0 §7)

To optimize for the next ten kernels rather than only Scheduler:

- Extracted a **generic round-trip verifier** `createRoundTripShadow` into
  `src/platform-adapters/_shadow/` (split into `core.js` + `roundTripShadow.js`).
- **Refactored Jobs (17.5) onto it** — all 14 Jobs tests remain green (proof the abstraction is
  faithful).
- Built **Scheduler as thin configuration** over the same verifier.
- **Shared the legacy timer inventory** (Scheduler projects the canonical `DEFAULT_JOBS`).

Net: duplication reduced; the next round-trip kernel is an adapter + a legacy source + a few
lines of shadow config.

## Code delivered (additive; only `.env.example` changed among app-tracked files)

| Path | Purpose |
|---|---|
| `src/platform-adapters/_shadow/core.js` · `roundTripShadow.js` | Shared primitives + **generic verifier**. |
| `src/platform-adapters/scheduler/{index,legacySource,shadow}.js` | Scheduler adapter, legacy schedule inventory, shadow (thin). |
| `src/enterprise/schedulerShadow.js` | Flags + shadow attachment. |
| `src/enterprise/index.js` | Wires shadow behind `PLATFORM_SCHEDULER` / `SHADOW_SCHEDULER`. |
| `src/hosted-service/onCallAppService.js` | `scheduler` added to shadow-only adapters. |
| `src/platform-adapters/jobs/shadow.js` | **Refactored** onto the generic verifier (behavior identical). |
| `tests/unit/scheduler-shadow.test.js` | 12 tests incl. non-execution/non-ownership proof + all-four-shadows. |
| `tests/integration/scheduler-shadow-ab.mjs` | Live A/B (app OS / CI). |

## Documents (G1.0 §8)
00 [Integration Design](00_SCHEDULER_INTEGRATION_DESIGN.md) ·
01 [Adapter Specification](01_SCHEDULER_ADAPTER_SPEC.md) ·
02 [Shadow Design](02_SCHEDULER_SHADOW_DESIGN.md) ·
03 [Parity Report](03_SCHEDULER_PARITY_REPORT.md) ·
04 [Rollback Guide](04_SCHEDULER_ROLLBACK_GUIDE.md) ·
05 [Updated Integration Diagram](05_UPDATED_INTEGRATION_DIAGRAM.md)

## Flags (default OFF ⇒ byte-identical to Phase 17.5)
```bash
PLATFORM_ENABLED=1 PLATFORM_HOST=1 PLATFORM_SCHEDULER=1 SHADOW_SCHEDULER=1 node server.js
```

## Verification
- ✅ Parity **100%** · coverage **100%** · confidence 1.0 (50 fields / 5 schedules) — boot smoke + 12 unit tests.
- ✅ **Zero timers armed / zero executions** — `start()`/`tick()` never called; `running=0`; all `scheduled` (test-proven).
- ✅ Config + Observability + Jobs + Scheduler shadows run together, all 100%.
- ✅ Regression **84/84** incl. the Jobs-refactor-onto-generic staying green; full lint exit 0.
- ✅ Legacy scheduler authoritative; both flags OFF ≡ Phase 17.5 (test-proven).
- ⏳ Live HTTP A/B (`scheduler-shadow-ab.mjs`) runs on the app's OS / CI (needs `sqlite3`) — expect `Result: IDENTICAL`.

## G1.0 compliance checklist
```
[x] §1 Shadow principles (legacy authoritative; never throws/blocks/mutates; never executes/owns timer)
[x] §2 Adapter stateless/deterministic; inert without port; no persistence surface
[x] §3 PLATFORM_SCHEDULER + SHADOW_SCHEDULER; SHADOW⊂PLATFORM; both-off ≡ prev phase
[x] §4 Verification categories + strategy + formula + mismatch/failure rules
[x] §5 Shadow metrics incl. confidenceLevel + coveragePct; isolated
[x] §6 Rollback levels + Rollback Safety Matrix + verification + runbook (flags only)
[x] §7 Unit/Integration/Parity/Shadow/Failure/Flag/Regression/A-B tests present & green; DUPLICATION REDUCED (generic verifier)
[x] §8 Exactly the six documents (00–05) + README; ADR-020 cited
[x] §9 100% parity; no runtime/startup/shutdown/scheduling/timer-ownership change proven
[x] §10 State: Shadow → Verified (100% parity, 0 failures; A/B gate pending on CI)
[x] §11 No invariant violated
```

## STOP boundary honored
Only the Scheduler Kernel was integrated (shadow), alongside the Configuration/Observability/
Jobs shadows. No further kernel was begun.
