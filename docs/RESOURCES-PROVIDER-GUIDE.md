# Enterprise Resource Management Kernel — Provider Guide (ADR-039 §4)

A Resource provider **stores resource definitions and allocation state only**. It never
allocates, enforces quota, preempts, or emits events — all of that lives in the engine, so
engine behavior is identical regardless of which provider is active. This is the seam a
future PostgreSQL / Storage / Redis / MongoDB / cloud-registry adapter slots behind.

## Contract

Implement every method (all async unless noted). `assertProvider` fails fast at composition
time if any is missing.

| Method                                       | Returns         | Notes                                |
| -------------------------------------------- | --------------- | ------------------------------------ |
| `name`                                       | `string`        | Non-empty adapter name.              |
| `putResource(namespace, model)`             | `void`          | Upsert a resource by `resourceId`.   |
| `getResource(namespace, resourceId)`        | `model \| null` | A resource, or `null`.               |
| `listResources(namespace)`                  | `model[]`       | All resources in the namespace.      |
| `removeResource(namespace, resourceId)`     | `boolean`       | `true` if removed.                   |
| `putAllocation(namespace, model)`          | `void`          | Upsert an allocation by `allocationId`. |
| `getAllocation(namespace, allocationId)`   | `model \| null` | An allocation, or `null`.            |
| `listAllocations(namespace)`               | `model[]`       | All allocations in the namespace.    |
| `health()`                                  | `{ ok, ... }`   | Liveness + counts.                   |

### Model shapes (opaque to the provider)

```jsonc
// resource
{ "resourceId": "res_...", "namespace": "default", "resourceType": "cpu", "owner": null,
  "capacity": 100, "allocated": 30, "available": 70, "quota": 40, "reservation": 20,
  "priority": 0, "status": "active", "labels": {}, "metadata": {},
  "checksum": "<sha256 hex>", "createdAt": 0, "updatedAt": 0, "version": 3 }

// allocation
{ "allocationId": "alc_...", "resourceId": "res_...", "namespace": "default",
  "owner": "trips", "amount": 10, "priority": 5, "status": "active",
  "createdAt": 0, "releasedAt": null, "checksum": "<sha256 hex>" }
```

The provider treats both as opaque: round-trip every field (deep copies to avoid aliasing),
never recompute the `checksum`, and never mutate. The engine derives a resource's
`allocated` from the active allocation set and relies on the provider to persist both
faithfully — `verify()` flags any drift.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Per namespace, a `resources` map
  and an `allocations` map. Single-process.

## Future extension points (declared, not implemented)

`postgresql`, `storage` (Enterprise Storage Platform, ADR-021), `redis`, `mongodb`,
`cloud-registry`, `custom`.

```js
const { futureProvider } = require('../../src/application/resources/providerPort');
const p = futureProvider('postgresql'); // { planned: true, ... }
p.putResource('ns', {}); // throws: "extension point — not implemented in Phase 15.10"
```

## Writing a new provider

1. Implement the contract above; deep-copy models in and out.
2. Map not-found to `null` (never throw for a missing resource/allocation).
3. Keep it behavior-free — no allocation/quota/preemption/events. The engine owns those.
   Persist and return the `checksum` verbatim.
4. For a multi-node store, `putResource`/`putAllocation` on the allocation hot path should be
   transactional together (or guarded by the Lock kernel), so `allocated` and the active
   allocation set stay consistent; the in-process engine already serializes per resource.
5. Wire it in the composition root: `createResourcePlatform({ provider: myProvider })`.

## Guarantees the engine relies on

- **Round-trip fidelity** — a resource/allocation read back equals what was written
  (deep-copied), including `checksum`.
- **Isolation** — namespaces never bleed into each other.
