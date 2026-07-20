# Enterprise Feature Flag Kernel — Provider Guide (ADR-029 §4)

A Feature Flag provider **stores flag definitions only**. It performs no feature behavior —
no evaluation, targeting, rollout, caching, integrity, or events. All of that lives in the
evaluation engine, so engine behavior is identical regardless of which provider is active.
This is the seam a future Storage / PostgreSQL / Redis / MongoDB / cloud-config adapter
slots behind.

## Contract

Implement every method (all async unless noted). `assertProvider` fails fast at composition
time if any is missing.

| Method                          | Returns         | Notes                                    |
| ------------------------------- | --------------- | ---------------------------------------- |
| `name`                          | `string`        | Non-empty adapter name.                  |
| `putFlag(namespace, model)`     | `void`          | Upsert the definition by `model.name`.   |
| `getFlag(namespace, name)`      | `model \| null` | The stored definition, or `null`.        |
| `listFlags(namespace)`          | `model[]`       | All definitions in the namespace.        |
| `removeFlag(namespace, name)`   | `boolean`       | `true` if a definition was removed.      |
| `health()`                      | `{ ok, ... }`   | Liveness + counts.                       |

### Definition model shape (opaque to the provider)

```jsonc
{
  "flagId": "flg_...",
  "name": "new-checkout",
  "namespace": "default",
  "description": "",
  "state": "enabled",          // enabled | disabled | archived
  "defaultValue": true,
  "offValue": false,
  "rules": [ { "id": "r0", "priority": 0, "when": {}, "value": true, "rollout": null } ],
  "targeting": null,           // { attr: constraint, ... } or null
  "rollout": { "percentage": 25, "salt": null, "attribute": null },
  "appVersion": ">=2.0.0",     // semver range or null
  "platform": ["ios"],          // scalar | array | null
  "country": null, "region": null, "tenant": null, "environment": null,
  "priority": 0,
  "metadata": {},
  "createdAt": 0, "updatedAt": 0,
  "version": 1,
  "checksum": "<sha256 hex>"    // content checksum — the engine owns it
}
```

The provider treats the model as opaque: round-trip every field (deep copies to avoid
aliasing), never recompute the checksum, and never mutate the definition. The engine keys
its evaluation cache on `checksum`, so the provider must return exactly what was written.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Per namespace, a `name → model`
  map. Single-process. Ideal for tests and single-node deployments.

## Future extension points (declared, not implemented)

`storage` (Enterprise Storage Platform, ADR-021), `postgresql`, `redis`, `mongodb`,
`cloud-config`, `custom`.

```js
const { futureProvider } = require('../../src/application/features/providerPort');
const p = futureProvider('redis'); // { planned: true, ... }
p.putFlag('ns', {}); // throws: "extension point — not implemented in Phase 15.0"
```

## Writing a new provider

1. Implement the contract above; deep-copy models in and out.
2. Map your backend's not-found to `null` (never throw for a missing flag).
3. Keep it behavior-free — no evaluation/targeting/rollout/cache/events. The engine owns
   those. Persist and return the `checksum` verbatim.
4. For a distributed store (Redis/Postgres), a change to a definition must change the
   persisted `checksum` (the engine already bumps it on every write) — that is what
   invalidates evaluation caches across nodes.
5. Wire it in the composition root: `createFeaturePlatform({ provider: myProvider })`.

## Guarantees the engine relies on

- **Round-trip fidelity** — a model read back equals what was written (deep-copied),
  including `checksum`.
- **Deterministic reads** — `getFlag(ns, name)` returns the same definition until the next
  write.
- **Isolation** — namespaces never bleed into each other.
