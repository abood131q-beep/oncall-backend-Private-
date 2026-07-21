# Phase 17.4 — Observability Shadow Design

`src/platform-adapters/observability/shadow.js` implements the shadow pass and parity
verification. Defining property: it can never change what the caller gets, never block, and
never crash the caller.

---

## 1. `verify()` — one parity pass (async, out-of-band)

```
recordRequest()
legacyObs = legacy.observe()                         # authoritative snapshot
if (!enabled() || !adapter.consumed()) return { enabled:false, parityPct:100 }   # short-circuit
t0 = now
try:
  componentId = await adapter.record(legacyObs)      # write shadow copy into the kernel
  kernelObs   = await adapter.readComponent(componentId)  # read it back, decoded
  compare(flatten(legacyObs), flatten(kernelObs))    # field-by-field deep compare
  return { enabled:true, fields, matched, mismatched, parityPct, confidenceLevel }
catch e:
  recordVerificationFailure(e); return { enabled:true, parityPct:0, error }   # never throw
```

## 2. `shadowObserve()` — always returns legacy

```
legacyObs = legacy.observe()
if (enabled() && adapter.consumed())
    Promise.resolve().then(verify).catch(()=>{})     # fire-and-forget: never blocks/throws
return legacyObs                                     # ← authoritative, unconditional
```

This is how the shadow satisfies every rule: `record()` **never throws** (caught),
**never blocks** (fire-and-forget), **never retries synchronously**, **never modifies
runtime/health/metrics**, and **always returns the legacy result**.

## 3. Comparison

`flatten()` turns each observation into dotted leaf keys
(`health.status`, `health.checks.memory`, `health.tags.component`, `readiness.ready`,
`liveness.live`, `counters.requests_total`, `gauges.cpu_percent`, `timers.response_p50`,
`event.service`, `log.level`, …). Each leaf is compared with a deterministic `deepEqual`
(handles primitives, arrays, objects, `NaN`). The only ignored key is `event.componentId`
(a logical label; the kernel uses fresh physical component ids per pass).

## 4. Verified categories (mission checklist)

| Category | Leaf keys compared |
|---|---|
| Health | `health.status` |
| Health State | health enum round-trip (`ok↔healthy`) |
| Health Tags | `health.tags.*` (via component metadata) |
| Readiness | `readiness.ready` |
| Liveness | `liveness.live` |
| Metrics / Counters | `counters.requests_total/4xx/5xx` |
| Gauges | `gauges.cpu_percent/sampled/uptime_seconds/heap_used_bytes/rss_bytes` |
| Timers / Latency | `timers.response_p50/p95/p99` |
| Event Metadata | `event.service` |
| Structured Log Metadata | `log.level`, `log.requestIdHeader` |

Boot smoke: **21 fields, all matched, parity 100%, confidence 1.0.**

## 5. Observability — shadow metrics

`src/platform-adapters/observability/metrics.js` (in-memory, isolated from the app's
`/metrics`):

| Metric | Meaning |
|---|---|
| `requests` | shadow passes initiated |
| `comparisons` | per-field comparisons performed |
| `matches` / `mismatches` | comparison outcomes |
| `verificationFailures` | kernel/adapter errors during a pass |
| `latency` | `{ samples, avgMs, maxMs }` |
| `parityPct` | `matches / comparisons * 100` |
| `confidenceLevel` | `matchRatio × min(1, comparisons/20)` — low-sample caps confidence |
| `mismatches_log` | bounded ring of mismatch/failure descriptors |

Recording a metric has **no** runtime effect and never touches the application's metrics
collector — the `/metrics` endpoint is byte-unchanged.
