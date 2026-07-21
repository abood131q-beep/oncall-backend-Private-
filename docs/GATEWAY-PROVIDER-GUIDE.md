# Enterprise API Gateway Kernel — Provider Guide (ADR-035 §4)

An API Gateway provider **stores route definitions only**. It never matches, dispatches,
runs middleware, enforces policy, or emits events — all of that lives in the engine, so
engine behavior is identical regardless of which provider is active. This is the seam a
future Kong / Envoy / NGINX / cloud-gateway adapter slots behind.

## Contract

Implement every method (all async unless noted). `assertProvider` fails fast at composition
time if any is missing.

| Method                                | Returns         | Notes                             |
| ------------------------------------- | --------------- | --------------------------------- |
| `name`                                | `string`        | Non-empty adapter name.           |
| `putRoute(namespace, model)`          | `void`          | Upsert a route by `routeId`.      |
| `getRoute(namespace, routeId)`        | `model \| null` | A route, or `null`.               |
| `listRoutes(namespace)`               | `model[]`       | All routes in the namespace.      |
| `removeRoute(namespace, routeId)`     | `boolean`       | `true` if removed.                |
| `health()`                            | `{ ok, ... }`   | Liveness + counts.                |

### Route model shape (opaque to the provider)

```jsonc
{
  "routeId": "rt_...",
  "namespace": "default",
  "method": "GET",
  "path": "/trips/:id",
  "version": ">=1.0.0",
  "targetService": "trips",         // OR targetEndpoint
  "targetEndpoint": null,
  "policies": ["trips:read"],
  "middlewareChain": ["requestId"],  // names of engine-registered middleware
  "authRequired": true,
  "rateLimitPolicy": "api",
  "timeout": 30000,
  "priority": 10,
  "metadata": { "featureFlag": "new-trips" },
  "checksum": "<sha256 hex>",        // engine-owned; round-trip verbatim
  "createdAt": 0, "updatedAt": 0
}
```

The provider treats the model as opaque: round-trip every field (deep copies to avoid
aliasing), never recompute the `checksum`, and never mutate. Note the `middlewareChain`
holds middleware **names**; the executable functions live only in the engine's in-process
registry (never persisted), which is why middleware registration is administrative.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Per namespace, a `routeId →
  model` map. Single-process. Ideal for tests and single-node deployments.

## Future extension points (declared, not implemented)

`kong`, `envoy`, `nginx`, `cloud-gateway`, `custom`.

```js
const { futureProvider } = require('../../src/application/gateway/providerPort');
const p = futureProvider('kong'); // { planned: true, ... }
p.putRoute('ns', {}); // throws: "extension point — not implemented in Phase 15.6"
```

## Writing a new provider

1. Implement the contract above; deep-copy models in and out.
2. Map not-found to `null` (never throw for a missing route).
3. Keep it behavior-free — no matching/dispatch/middleware/policy/events. The engine owns
   those. Persist and return the `checksum` verbatim.
4. For a config-push backend (Kong/Envoy), translate the stored route model into the
   backend's config on `putRoute`; the engine remains the source of truth and the authority
   for enforcement decisions.
5. Wire it in the composition root: `createGatewayPlatform({ provider: myProvider })`.

## Guarantees the engine relies on

- **Round-trip fidelity** — a route read back equals what was written (deep-copied),
  including `checksum`.
- **Isolation** — namespaces never bleed into each other.
