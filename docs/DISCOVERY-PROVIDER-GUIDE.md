# Enterprise Service Discovery Kernel — Provider Guide (ADR-034 §4)

A Service Discovery provider **stores service definitions only**. It never matches, orders,
selects, health-checks, or emits events — all of that lives in the engine, so engine
behavior is identical regardless of which provider is active. This is the seam a future
Consul / etcd / Kubernetes / DNS / cloud-registry adapter slots behind.

## Contract

Implement every method (all async unless noted). `assertProvider` fails fast at composition
time if any is missing.

| Method                                   | Returns         | Notes                              |
| ---------------------------------------- | --------------- | ---------------------------------- |
| `name`                                   | `string`        | Non-empty adapter name.            |
| `putService(namespace, model)`           | `void`          | Upsert a service by `serviceId`.   |
| `getService(namespace, serviceId)`       | `model \| null` | A service, or `null`.              |
| `listServices(namespace)`                | `model[]`       | All services in the namespace.     |
| `removeService(namespace, serviceId)`    | `boolean`       | `true` if removed.                 |
| `health()`                               | `{ ok, ... }`   | Liveness + counts.                 |

### Service model shape (opaque to the provider)

```jsonc
{
  "serviceId": "svc_...",
  "namespace": "default",
  "serviceName": "trips",
  "version": "2.3.0",
  "instanceId": "ins_...",
  "endpoint": "http://10.0.0.7:8080",
  "protocol": "http",
  "capabilities": ["book", "cancel"],
  "tags": ["prod"],
  "healthStatus": "healthy",     // healthy | degraded | failed | unknown
  "priority": 10, "weight": 5,
  "metadata": { "zone": "a" },
  "checksum": "<sha256 hex>",    // engine-owned; over the DEFINITION (not health)
  "createdAt": 0, "updatedAt": 0
}
```

The provider treats the model as opaque: round-trip every field (deep copies to avoid
aliasing), never recompute the `checksum`, and never mutate. The checksum covers the
definition (endpoint + capabilities + routing) but not `healthStatus`, so health updates
are cheap and do not invalidate endpoint integrity.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Per namespace, a `serviceId →
  model` map. Single-process. Ideal for tests and single-node deployments.

## Future extension points (declared, not implemented)

`consul`, `etcd`, `kubernetes`, `dns`, `cloud-registry`, `custom`.

```js
const { futureProvider } = require('../../src/application/discovery/providerPort');
const p = futureProvider('consul'); // { planned: true, ... }
p.putService('ns', {}); // throws: "extension point — not implemented in Phase 15.5"
```

## Writing a new provider

1. Implement the contract above; deep-copy models in and out.
2. Map not-found to `null` (never throw for a missing service).
3. Keep it behavior-free — no matching/ordering/selection/health/events. The engine owns
   those. Persist and return the `checksum` verbatim.
4. For a watch-capable backend (Consul/etcd), invalidate the engine's per-namespace cache on
   change by re-registering through the engine, or expose a change feed the composition root
   wires to `cache.invalidate(namespace)`.
5. Map external health signals into the model's `healthStatus` before `putService` — the
   engine reads it for health-aware selection but does not health-check itself.
6. Wire it in the composition root: `createDiscoveryPlatform({ provider: myProvider })`.

## Guarantees the engine relies on

- **Round-trip fidelity** — a service read back equals what was written (deep-copied),
  including `checksum`.
- **Isolation** — namespaces never bleed into each other.
