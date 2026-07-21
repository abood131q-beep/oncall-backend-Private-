# Enterprise Lifecycle Management Kernel — Provider Guide (ADR-040 §4)

A Lifecycle provider **stores lifecycle metadata only** — component definitions and their
last-known state. It never orchestrates startup/shutdown, orders dependencies, validates
transitions, or emits events — all of that lives in the engine, so engine behavior is
identical regardless of which provider is active. This is the seam a future PostgreSQL /
Storage / Redis / MongoDB / cloud-registry adapter slots behind.

## Contract

Implement every method (all async unless noted). `assertProvider` fails fast at composition
time if any is missing.

| Method                                       | Returns         | Notes                              |
| -------------------------------------------- | --------------- | ---------------------------------- |
| `name`                                       | `string`        | Non-empty adapter name.            |
| `putComponent(namespace, model)`            | `void`          | Upsert a component by `componentId`.|
| `getComponent(namespace, componentId)`      | `model \| null` | A component, or `null`.            |
| `listComponents(namespace)`                 | `model[]`       | All components in the namespace.   |
| `removeComponent(namespace, componentId)`   | `boolean`       | `true` if removed.                 |
| `health()`                                  | `{ ok, ... }`   | Liveness + counts.                 |

### Component model shape (opaque to the provider)

```jsonc
{
  "componentId": "cmp_...",
  "namespace": "default",
  "componentType": "service",
  "lifecycleState": "started",     // registered|initialized|started|suspended|stopped|failed
  "dependencies": ["db"],
  "startupPriority": 10, "shutdownPriority": 0,
  "initializationPolicy": "eager", "restartPolicy": "on-failure",
  "healthStatus": "unknown",
  "metadata": {},
  "checksum": "<sha256 hex>",      // engine-owned; round-trip verbatim
  "createdAt": 0, "updatedAt": 0, "version": 3
}
```

The provider treats the model as opaque: round-trip every field (deep copies to avoid
aliasing), never recompute the `checksum`, and never mutate. Note the executable hooks
(initialize/start/stop functions) are **not** part of the model — they live only in the
engine's in-process registry, which is why component registration is administrative.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Per namespace, a `componentId →
  model` map. Single-process.

## Future extension points (declared, not implemented)

`postgresql`, `storage` (Enterprise Storage Platform, ADR-021), `redis`, `mongodb`,
`cloud-registry`, `custom`.

```js
const { futureProvider } = require('../../src/application/lifecycle/providerPort');
const p = futureProvider('postgresql'); // { planned: true, ... }
p.putComponent('ns', {}); // throws: "extension point — not implemented in Phase 15.11"
```

## Writing a new provider

1. Implement the contract above; deep-copy models in and out.
2. Map not-found to `null` (never throw for a missing component).
3. Keep it behavior-free — no ordering/transition/orchestration/events. The engine owns
   those. Persist and return the `checksum` and `lifecycleState` verbatim so a restart of
   the engine can resume from the last-known state.
4. For a shared store, `putComponent` on a state transition should be atomic; the in-process
   engine serializes orchestration per namespace, but cross-node coordination is the
   provider's (or the Lock kernel's) responsibility.
5. Wire it in the composition root: `createLifecyclePlatform({ provider: myProvider })`.

## Guarantees the engine relies on

- **Round-trip fidelity** — a component read back equals what was written (deep-copied),
  including `checksum` and `lifecycleState`.
- **Isolation** — namespaces never bleed into each other.
