# Enterprise Observability Kernel — Developer Guide (ADR-033)

The Observability Kernel is the platform's unified abstraction for deterministic health
reporting, diagnostics, metric aggregation, tracing abstractions, and runtime visibility
across all Kernel Services. It is **not Prometheus/OpenTelemetry/Grafana/Datadog** and
**not a logging framework** — those are export-provider extension points. It lives under
`observability/`, additive to every existing kernel.

## 1. Compose

```js
const { createObservabilityPlatform } = require('../../src/application/observability');
const ok = createObservabilityPlatform({
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
});
const O = ok.observability;
```

## 2. Register + collect (self-reporting components)

```js
O.register({ componentId: 'trips', service: 'trips-service' });
await O.collect({
  componentId: 'trips',
  health: 'healthy', // healthy | degraded | failed | unknown
  counters: { requests: 1, errors: 0 }, // ADDED to running totals
  gauges: { openConnections: 12 }, // SET to the latest value
  timers: { dbQuery: 8 }, // accumulate {count, totalMs, lastMs}
  traceContext: { traceId: 't1', spanId: 's1' },
  metadata: { region: 'us-east' },
});
// collect upserts — the first collect auto-registers the component.
```

Any kernel can report the data it already exposes through its own `metrics.snapshot()` and
`health()` — no kernel internals are read; components push via `collect()`.

## 3. Snapshot (deterministic aggregate)

```js
const snap = await O.snapshot({ namespace: 'default' });
// → { snapshotId, namespace, generatedAt, status, breakdown,
//     metrics: { counters, gauges, timers, componentCount }, components, checksum }
```

Aggregation is deterministic and order-independent: counters and gauges sum, timers merge
(with a derived `avgMs`), and health rolls up worst-of. The snapshot is persisted via the
provider and checksum-verifiable.

## 4. Diagnostics (redacted runtime view)

```js
const d = await O.diagnostics({ namespace: 'default' /*, componentId */ });
// → { namespace, generatedAt, health, breakdown, failures, components, engine }
```

Sensitive metadata (keys matching secret/token/password/apiKey/credential/…) is redacted
to `***REDACTED***` in the diagnostic view.

## 5. Verify + health

```js
await O.verify({ namespace }); // → { ok, issues } — component + snapshot checksum integrity
await O.health(); // → { ok, status, breakdown, components, provider, metrics }
```

## 6. Trace context propagation

```js
const root = O.propagateTrace({}); // { traceId, parentSpanId: null, spanId }
const child = O.propagateTrace(root); // same traceId, parentSpanId = root.spanId
```

## 7. Events (through the port only)

`MetricsCollected`, `SnapshotCreated`, `HealthChanged`, `DiagnosticsGenerated`,
`VerificationCompleted` — all via the Event Backbone, producer `observability`.
`HealthChanged` fires only when a component's status actually changes.

## 8. Observability (the kernel's own metrics)

```js
ok.metrics.snapshot(); // registered/healthy/degraded/failed components (gauges),
// metricsCollected, diagnosticSnapshots, verificationRuns, providerFailures, latency, uptime
ok.metrics.prometheus();
```

## 9. SDK integration (ADR-018)

```js
const { toObservabilityPort } = require('../../src/application/observability/sdkAdapter');
const portFactories = {
  'observability:read': () => toObservabilityPort(ok.observability, { owner: extId, canDiagnostics: false }),
  'observability:diagnostics': () => toObservabilityPort(ok.observability, { owner: extId }),
};
// Inside the extension: this.observability().collect({ componentId, health, counters })
```

Every call is forced into the extension's namespace (`ext.<owner>`). `register`/`collect`/
`snapshot` require `observability:read`; `diagnostics`/`verify` require
`observability:diagnostics`. Redaction still applies to a granted diagnostics view.

## Determinism, aggregation & integrity

- **Deterministic** — an injected clock drives timestamps; aggregation processes components
  in `componentId` order, so the same inputs always yield the same snapshot.
- **Concurrency-safe** — per-component reports serialize via a mutex, so counters never lose
  updates under concurrent `collect()`.
- **Integrity** — every component and snapshot carries a checksum; `verify()` recomputes
  both across a namespace to detect tampering/corruption.

## Out of scope (future work behind the provider port)

Real exporters (Prometheus/OpenTelemetry/Grafana/Datadog/cloud monitoring), durable snapshot
retention, and distributed trace collection are declared extension points, not implemented
in this phase. The memory provider is single-process.
