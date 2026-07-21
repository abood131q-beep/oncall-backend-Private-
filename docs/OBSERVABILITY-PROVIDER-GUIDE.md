# Enterprise Observability Kernel — Provider Guide (ADR-033 §4)

An Observability provider **stores or exports telemetry only**. It persists snapshots
and/or ships metric payloads to an external system. It never aggregates, computes health,
generates diagnostics, verifies, or emits kernel events — all of that lives in the engine,
so engine behavior is identical regardless of which provider is active. This is the seam a
future Prometheus / OpenTelemetry / Grafana / Datadog / cloud-monitoring adapter slots
behind.

## Contract

Implement every method (all async unless noted). `assertProvider` fails fast at composition
time if any is missing.

| Method                                | Returns            | Notes                                     |
| ------------------------------------- | ------------------ | ----------------------------------------- |
| `name`                                | `string`           | Non-empty adapter name.                   |
| `exportMetrics(namespace, payload)`   | `void`             | Ship a per-collect telemetry payload out. |
| `putSnapshot(namespace, snapshot)`    | `void`             | Persist an aggregated snapshot.           |
| `getSnapshot(namespace, snapshotId)`  | `snapshot \| null` | A stored snapshot, or `null`.             |
| `listSnapshots(namespace)`            | `snapshot[]`       | All snapshots in the namespace.           |
| `health()`                            | `{ ok, ... }`      | Liveness + counts.                        |

### Payload shapes (opaque to the provider)

`exportMetrics` payload (one per `collect`):

```jsonc
{ "componentId": "trips", "service": "trips", "healthStatus": "healthy",
  "metrics": { "counters": {}, "gauges": {}, "timers": {} }, "at": 0 }
```

`putSnapshot` snapshot (aggregated):

```jsonc
{ "snapshotId": "snp_...", "namespace": "default", "generatedAt": 0,
  "status": "healthy", "breakdown": { "healthy": 2, "degraded": 0, "failed": 0, "unknown": 0 },
  "metrics": { "counters": {}, "gauges": {}, "timers": {}, "componentCount": 2 },
  "components": [ /* component models */ ], "checksum": "<sha256 hex>" }
```

The provider treats both as opaque: round-trip every field (deep copies to avoid aliasing),
never recompute the snapshot `checksum`, and never mutate. `verify()` recomputes the
snapshot checksum from the stored fields, so a provider that alters a snapshot will be
flagged.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Per namespace, a `snapshotId →
  snapshot` map plus an ordered export log (`exports(namespace)` for inspection).
  Single-process. Ideal for tests and single-node deployments.

## Future extension points (declared, not implemented)

`prometheus`, `opentelemetry`, `grafana`, `datadog`, `cloud-monitoring`, `custom`.

```js
const { futureProvider } = require('../../src/application/observability/providerPort');
const p = futureProvider('prometheus'); // { planned: true, ... }
p.exportMetrics('ns', {}); // throws: "extension point — not implemented in Phase 15.4"
```

## Writing a new provider

1. Implement the contract above; deep-copy payloads in and out.
2. `exportMetrics` is the hot path (one call per `collect`) — make it cheap / batched /
   fire-and-forget as appropriate; a thrown error is counted as a provider failure and
   surfaces to the caller.
3. Keep it behavior-free — no aggregation/health/diagnostics/verify/events. The engine owns
   those. Persist and return the snapshot `checksum` verbatim.
4. Map not-found to `null` (never throw for a missing snapshot).
5. Wire it in the composition root: `createObservabilityPlatform({ provider: myProvider })`.

## Guarantees the engine relies on

- **Round-trip fidelity** — a snapshot read back equals what was written (deep-copied),
  including `checksum`.
- **Isolation** — namespaces never bleed into each other.
