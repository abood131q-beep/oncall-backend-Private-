# Enterprise Resilience Kernel — Provider Guide (ADR-036 §4)

A Resilience provider **stores policies and circuit/execution state only**. It never
executes, retries, times out, trips circuits, or emits events — all of that lives in the
engine, so engine behavior is identical regardless of which provider is active. This is the
seam a future Redis / PostgreSQL / Storage / MongoDB adapter slots behind.

## Contract

Implement every method (all async unless noted). `assertProvider` fails fast at composition
time if any is missing.

| Method                                   | Returns          | Notes                                  |
| ---------------------------------------- | ---------------- | -------------------------------------- |
| `name`                                   | `string`         | Non-empty adapter name.                |
| `putPolicy(namespace, model)`            | `void`           | Upsert a policy by `policyId`.         |
| `getPolicy(namespace, policyId)`         | `model \| null`  | A policy, or `null`.                   |
| `listPolicies(namespace)`                | `model[]`        | All policies in the namespace.         |
| `removePolicy(namespace, policyId)`      | `boolean`        | `true` if removed.                     |
| `getState(namespace, key)`               | `state \| null`  | Circuit state for a `policyId::subject`. |
| `putState(namespace, key, state)`        | `void`           | Persist circuit state.                 |
| `resetState(namespace, key)`             | `boolean`        | Clear one circuit's state.             |
| `health()`                               | `{ ok, ... }`    | Liveness + counts.                     |

### State shape (opaque to the provider)

```jsonc
{ "state": "closed", "failures": 0, "successes": 0, "openedAt": null, "updatedAt": 0, "lastError": null }
// state ∈ { closed, open, half_open }
```

Policy `model` carries a `checksum` the engine owns — round-trip it verbatim; never
recompute. Circuit `state` is likewise opaque: persist and return it exactly.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Per namespace, a `policies` map
  and a `state` map. Single-process. Ideal for tests and single-node deployments.

## Future extension points (declared, not implemented)

`redis`, `postgresql`, `storage` (Enterprise Storage Platform, ADR-021), `mongodb`,
`custom`.

```js
const { futureProvider } = require('../../src/application/resilience/providerPort');
const p = futureProvider('redis'); // { planned: true, ... }
p.putState('ns', 'k', {}); // throws: "extension point — not implemented in Phase 15.7"
```

## Writing a new provider

1. Implement the contract above; deep-copy models/state in and out.
2. Map not-found to `null` (never throw for a missing policy/state).
3. Keep it behavior-free — no execution/retry/timeout/circuit/events. The engine owns those.
4. For a shared-state deployment (Redis/Postgres), `getState`/`putState` should be atomic (a
   compare-and-set or Lua script) so concurrent nodes converge on one circuit decision; the
   in-process engine already serializes per (policy, subject), but cross-node atomicity is
   the provider's responsibility.
5. Wire it in the composition root: `createResiliencePlatform({ provider: myProvider })`.

## Guarantees the engine relies on

- **Round-trip fidelity** — a policy/state read back equals what was written (deep-copied),
  including the policy `checksum`.
- **Isolation** — namespaces and state keys never bleed into each other.
