# Phase 17.6 — Scheduler Shadow Design

`src/platform-adapters/scheduler/shadow.js` is thin configuration over the **shared generic
round-trip verifier** `createRoundTripShadow` (`src/platform-adapters/_shadow/`). Governed by
G1.0 §1, §4, §5, §7.

---

## 1. Generic verifier (reused, not duplicated)

`createRoundTripShadow` implements the algorithm once:

```
recordRequest()
items = legacy.list()
if (!enabled() || !adapter.consumed()) return { enabled:false, [countLabel]: N, parityPct:100 }
setDeclaredSurface(#leafKeys of one item's comparable view)          # coveragePct base
for each item:
  ref  = await adapter.record(item)     # never start()/tick() (adapter contract)
  view = await adapter.readRef(ref)
  compare(flatten(buildLegacyView(item)), flatten(view))            # deep, field-by-field
return { enabled, [countLabel]:N, fields, matched, mismatched, mismatchKeys, parityPct, confidenceLevel, coveragePct }
# on any error: recordVerificationFailure(); return { parityPct:0, error }   — never throws
```

Guarantees (G1.0 §1) — never throws/blocks/mutates — live in the shared verifier, so every
kernel that adopts it inherits them.

## 2. Scheduler configuration

The Scheduler shadow supplies only what is kernel-specific:

```
buildLegacyView(d) = {
  descriptor: d,                                          # id, owner, kind, intervalMs, cron, enabled
  kernel: { name: d.id, owner: d.owner,
            scheduleType: expectedScheduleType(d.kind),   # interval | once
            status: 'scheduled' }                         # placed but never started ⇒ non-execution
}
itemKey     = (d) => d.id
countLabel  = 'schedules'
```

The kernel read-back reconstructs `{ descriptor: metadata.payload, kernel: {name,owner,scheduleType,status} }`.
`flatten` + `deepEqual` compare each leaf. 10 leaves per schedule × 5 schedules = **50
comparisons**.

## 3. Verified categories (mission checklist)

| Category | Leaf(s) |
|---|---|
| Schedule identity | `descriptor.id`, `kernel.name` |
| Owner | `descriptor.owner`, `kernel.owner` |
| Kind / cadence type | `descriptor.kind`, `kernel.scheduleType` (interval/once) |
| Interval cadence | `descriptor.intervalMs` |
| Cron | `descriptor.cron` (null for the legacy timers) |
| Enabled | `descriptor.enabled` |
| Lifecycle placement (non-execution) | `kernel.status` = `scheduled` (never running) |

## 4. Shadow metrics (shared, G1.0 §5)

`createShadowMetrics()` (shared) provides the full mandated set incl. `confidenceLevel` and
`coveragePct`, isolated and in-memory; recording never affects runtime. `coveragePct` =
`coveredLeafKeys / declaredSurface × 100`. Sensitive values redacted via shared `redactValue`.

## 5. Non-ownership / non-execution proof

Verified in `tests/unit/scheduler-shadow.test.js`:
- a fake kernel records whether `start()` / `tick()` were ever called → both **false**;
- placed schedules' statuses are all `scheduled`, never `running`;
- in the real-platform boot, `schedulerKernel.health().running === 0`.

## 6. Post-Implementation Review outcome (G1.0 §7)

Duplication was actively reduced: the verify-loop, comparison, and metrics now live once in the
shared framework; Jobs was migrated onto it (14 tests green); the legacy timer inventory has a
single source. Adding future round-trip kernels is now configuration, not new control flow.
