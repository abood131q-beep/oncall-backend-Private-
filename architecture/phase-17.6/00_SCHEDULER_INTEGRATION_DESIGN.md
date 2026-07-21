# Phase 17.6 — Scheduler Integration Design

> **Governing standard:** G1.0. **Authoritative (immutable) references:** ADR-020 (Scheduler
> Kernel), G1.0, Phase 17 Completion Report, Phase 17.5 (Jobs) Completion Report + implementation.
> This document references them; it does not redefine them.

**Status:** Implemented. **Scope:** integrate the Enterprise Scheduler Kernel (ADR-020) through
the Scheduler Adapter in **Shadow Mode only**, building on the Jobs (17.5) reference and the
shared shadow framework. The legacy scheduler remains the **only owner of timing** and the
**only producer of work**; the Scheduler Kernel is never authoritative, **never arms a timer**,
and **never executes**.

---

## 1. Objective

Prove the Scheduler Kernel can faithfully represent every legacy schedule — its identity,
owner, kind (interval/once), cadence, cron, and lifecycle placement — by registering each
schedule and comparing, **without** changing scheduling, timing, or ownership, and **without
ever arming a timer or executing**.

## 2. Why Scheduler is safe to shadow (ADR-020 property)

The Scheduler Kernel executes only when driven: `start(intervalMs)` arms a real timer and
`tick(now)` runs due jobs. The adapter calls **neither** — it only registers a schedule
(`scheduleRecurring` / `scheduleAt`, which compute the plan/next-run) and reads it back via
`jobSnapshot`. No timer is armed, nothing runs; placed schedules sit in `scheduled` state.

## 3. Reuse & generalization (G1.0 §7 — Post-Implementation Review)

This phase **generalized** the shadow infrastructure rather than duplicating Jobs:

- A **generic round-trip verifier** `createRoundTripShadow` was extracted into the shared
  framework (`src/platform-adapters/_shadow/roundTripShadow.js`). It captures the common
  "for each legacy item: record → readRef → compare" algorithm ONCE.
- **Jobs (17.5) was refactored onto it** — its 14 tests remain green, proving the abstraction.
- **Scheduler is thin configuration** over the same verifier (a `buildLegacyView` + labels).
- The **legacy inventory is shared**: the Scheduler source projects the *same* canonical timer
  inventory (`DEFAULT_JOBS`) onto its scheduling concern — no interval values are duplicated.

Result: adding the next kernel of this shape is now ~an adapter + a legacy source + a few lines
of shadow config. Optimized for the next ten integrations, not just Scheduler.

## 4. Shadow execution model (G1.0 §1)

```
Legacy Scheduler (setInterval timers)      ── SOURCE OF TRUTH / owns timing / produces all work
        │
        ▼
Scheduler Adapter ─────► Enterprise Scheduler Kernel (ADR-020)   [scheduleRecurring/At; NEVER start()/tick()]
        │                        │
        │                        ▼
        │               kernel job model (scheduled; never running) — never exposed
        ▼
Parity Verification (descriptor + native name/owner/scheduleType/status)
        ▼
Shared Shadow Metrics (parityPct / confidenceLevel / coveragePct)
        ▼
RETURN LEGACY BEHAVIOR
```

## 5. Components (all additive)

| File | Role |
|---|---|
| `src/platform-adapters/_shadow/roundTripShadow.js` | **Generic** round-trip verifier (new; shared). |
| `src/platform-adapters/_shadow/core.js` | Shared primitives (deepEqual/flatten/metrics) — split out for reuse. |
| `src/platform-adapters/scheduler/index.js` | Scheduler Adapter — schedule/register + read; never start/tick. |
| `src/platform-adapters/scheduler/legacySource.js` | Legacy schedule inventory (projects the canonical timers). |
| `src/platform-adapters/scheduler/shadow.js` | Scheduler shadow — thin config over the generic verifier. |
| `src/enterprise/schedulerShadow.js` | Flags + shadow attachment. |
| `src/enterprise/index.js` | Wires it behind `PLATFORM_SCHEDULER` / `SHADOW_SCHEDULER`. |

## 6. Legacy schedule inventory (unchanged; projected from the real timers)

| Schedule id | Kind → scheduleType | Cadence | Owner |
|---|---|---|---|
| `backup` | interval | 6 h | `src/services/backup.js` |
| `cache-sweep` | interval | 30 s | `src/services/cache.js` |
| `wal-checkpoint` | interval | 5 min | `src/app/onCallApplication.js` |
| `taxi-autofix` | interval | 1 h | `src/socket.js` |
| `ghost-trip-cleanup` | once (startup) | one-shot | `src/app/onCallApplication.js` |

## 7. How parity reaches 100%

The full legacy descriptor rides on the kernel job **`metadata.payload`** (serializable ⇒
lossless). Additionally the kernel-native `name` (identity), `owner`, `scheduleType`
(interval/once), and `status` are verified — proving the kernel represented the schedule with
correct cadence type in a **non-running** (`scheduled`) state without arming a timer.
`encode ∘ decode = identity` ⇒ **parity 100%**.

## 8. Feature flags (only two; default OFF) — G1.0 §3

| Flag | Effect | Default |
|---|---|---|
| `PLATFORM_SCHEDULER` | Inject the Scheduler kernel port into the adapter. | `0` |
| `SHADOW_SCHEDULER` | Additionally run parity comparisons. Requires `PLATFORM_SCHEDULER=1`. | `0` |

`selectSchedulerFlags()` enforces `SHADOW_SCHEDULER ⊂ PLATFORM_SCHEDULER`. Both OFF ⇒
**byte-identical to Phase 17.5** (test-proven).

## 9. Boundaries honored

Runtime/startup/shutdown/scheduling/timer-ownership/persistent-state all preserved; no schedule
executed; no timer armed; kernel never authoritative; never blocks; never throws. Only the
Scheduler Adapter talks to the kernel. Among tracked files only `.env.example` changed. No other
kernel is consumed (STOP boundary respected).
