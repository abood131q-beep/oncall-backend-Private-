# Phase 17.5 — Jobs Shadow Design

`src/platform-adapters/jobs/shadow.js` implements the parity pass over the shared shadow
framework (`src/platform-adapters/_shadow/`). Governed by G1.0 §1, §4, §5.

---

## 1. `verify()` — one parity pass (async, out-of-band, never executes)

```
recordRequest()
descriptors = legacy.list()
if (!enabled() || !adapter.consumed()) return { enabled:false, parityPct:100 }   # short-circuit
setDeclaredSurface(#leafKeys of one job's comparable shape)                        # coveragePct base
for each descriptor:
  placed  = await adapter.record(descriptor)      # register no-op + schedule/enqueue — NEVER tick
  kernelV = await adapter.readJob(placed.jobId, placed.namespace)
  compare( legacyView(descriptor), kernelV )      # field-by-field deep compare
return { enabled, jobs, fields, matched, mismatched, parityPct, confidenceLevel, coveragePct }
# on any error: recordVerificationFailure(); return { parityPct:0, error }   — never throws
```

`shadow` is executed once at boot when `SHADOW_JOBS=1`; it is out-of-band and never gates
scheduling. It **never** throws, blocks, or mutates app/persistent state.

## 2. Comparable shape

For each job, two sub-objects are compared:

```
legacyView(d) = {
  descriptor: d,                                  # id, kind, intervalMs, idempotent, owner, enabled
  kernel:     { type: d.id, status: expectedStatus(d.kind) }   # scheduled | queued (proves non-execution)
}
```

The kernel read-back reconstructs `{ descriptor: model.payload, kernel: { type, status } }`.
`flatten` reduces each to dotted leaves; `deepEqual` compares each leaf. 8 leaves per job × 5
jobs = **40 comparisons**.

## 3. Verified categories (mission checklist)

| Category | Leaf(s) |
|---|---|
| Job identity | `descriptor.id`, `kernel.type` |
| Kind | `descriptor.kind` |
| Scheduling cadence | `descriptor.intervalMs` |
| Idempotency | `descriptor.idempotent` |
| Ownership | `descriptor.owner` |
| Enabled | `descriptor.enabled` |
| Lifecycle placement (non-execution) | `kernel.status` ∈ {scheduled, queued} — never running/completed |

## 4. Shadow metrics (shared framework, G1.0 §5)

`createShadowMetrics()` provides the full mandated set: `requests, comparisons, matches,
mismatches, verificationFailures, latency, parityPct, confidenceLevel, coveragePct,
mismatches_log`. Isolated, in-memory; recording never affects runtime. `coveragePct` is
`coveredLeafKeys / declaredSurface × 100` (declaredSurface = distinct leaf keys). Sensitive
values are redacted in mismatch records via the shared `redactValue`.

## 5. Non-execution proof

The design's central safety property is verified two ways in `tests/unit/jobs-shadow.test.js`:
- a fake kernel records whether `tick()` was ever called → **false**;
- placed jobs' statuses are all `scheduled`/`queued`, never `running`/`completed`;
- in the real-platform boot, `jobsKernel.health().running === 0`.

## 6. Reuse (G1.0 §7)

This integration introduces the **shared shadow framework** and builds entirely on it, rather
than copying `deepEqual`/metrics a third time. It is the reference other kernels reuse; the
pre-G1.0 Configuration (17.3) and Observability (17.4) shadows retain their local copies and
may adopt the shared module when next touched (per the Phase 17 Completion Report).
