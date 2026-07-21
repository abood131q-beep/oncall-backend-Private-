# Enterprise Service Mesh Kernel — Provider Guide (ADR-037 §4)

A Service Mesh provider **stores connection definitions only**. It never invokes, routes,
evaluates policy, or emits events — all of that lives in the engine, so engine behavior is
identical regardless of which provider is active. This is the seam a future Istio / Linkerd
/ Consul Connect / cloud-mesh adapter slots behind.

## Contract

Implement every method (all async unless noted). `assertProvider` fails fast at composition
time if any is missing.

| Method                                       | Returns         | Notes                              |
| -------------------------------------------- | --------------- | ---------------------------------- |
| `name`                                       | `string`        | Non-empty adapter name.            |
| `putConnection(namespace, model)`            | `void`          | Upsert a connection by `connectionId`. |
| `getConnection(namespace, connectionId)`     | `model \| null` | A connection, or `null`.           |
| `listConnections(namespace)`                 | `model[]`       | All connections in the namespace.  |
| `removeConnection(namespace, connectionId)`  | `boolean`       | `true` if removed.                 |
| `health()`                                   | `{ ok, ... }`   | Liveness + counts.                 |

### Connection model shape (opaque to the provider)

```jsonc
{
  "connectionId": "con_...",
  "namespace": "default",
  "sourceService": "api-gateway",
  "destinationService": "trips",
  "protocol": "grpc",
  "trafficPolicy": { "maxConcurrent": 50, "rateLimitPolicy": "trips-rl" },
  "routingPolicy": { "strategy": "subset", "subset": "v2" },
  "securityPolicy": { "requireIdentity": true, "allowedSources": ["api-gateway"], "mtls": true },
  "retryPolicy": { "resiliencePolicyId": "trips-resilience" },
  "timeout": 2000,
  "priority": 0,
  "connectionState": "established",   // registered | established | closed
  "metadata": {},
  "checksum": "<sha256 hex>",         // engine-owned; round-trip verbatim
  "createdAt": 0, "updatedAt": 0
}
```

The provider treats the model as opaque: round-trip every field (deep copies to avoid
aliasing), never recompute the `checksum`, and never mutate. The checksum covers the
definition but not `connectionState`, so lifecycle transitions are cheap.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Per namespace, a `connectionId →
  model` map. Single-process. Ideal for tests and single-node deployments.

## Future extension points (declared, not implemented)

`istio`, `linkerd`, `consul-connect`, `cloud-mesh`, `custom`.

```js
const { futureProvider } = require('../../src/application/mesh/providerPort');
const p = futureProvider('istio'); // { planned: true, ... }
p.putConnection('ns', {}); // throws: "extension point — not implemented in Phase 15.8"
```

## Writing a new provider

1. Implement the contract above; deep-copy models in and out.
2. Map not-found to `null` (never throw for a missing connection).
3. Keep it behavior-free — no invocation/routing/policy/events. The engine owns those.
   Persist and return the `checksum` verbatim.
4. For a real mesh backend (Istio/Linkerd), translate the stored connection into the
   backend's config (VirtualService / AuthorizationPolicy) on `putConnection`; the engine
   remains the control-plane authority for admission decisions.
5. Wire it in the composition root: `createMeshPlatform({ provider: myProvider })`.

## Guarantees the engine relies on

- **Round-trip fidelity** — a connection read back equals what was written (deep-copied),
  including `checksum`.
- **Isolation** — namespaces never bleed into each other.
