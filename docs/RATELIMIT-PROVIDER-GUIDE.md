# Enterprise Rate Limiting Kernel — Provider Guide (ADR-031 §4)

A Rate Limiting provider **persists policy definitions and counter state only**. It never
evaluates, decays, decides admission, or emits events — all of that lives in the engine, so
engine behavior is identical regardless of which provider is active. This is the seam a
future Redis / Storage / PostgreSQL / MongoDB adapter slots behind.

## Contract

Implement every method (all async unless noted). `assertProvider` fails fast at composition
time if any is missing.

| Method                              | Returns          | Notes                                    |
| ----------------------------------- | ---------------- | ---------------------------------------- |
| `name`                              | `string`         | Non-empty adapter name.                  |
| `putPolicy(namespace, model)`       | `void`           | Upsert a policy definition by `policyId`.|
| `getPolicy(namespace, policyId)`    | `model \| null`  | A policy, or `null`.                     |
| `listPolicies(namespace)`           | `model[]`        | All policies in the namespace.           |
| `removePolicy(namespace, policyId)` | `boolean`        | `true` if removed.                       |
| `getCounter(namespace, key)`        | `state \| null`  | Counter state for a `policyId::subject`. |
| `putCounter(namespace, key, state)` | `void`           | Persist counter state.                   |
| `resetCounter(namespace, key)`      | `boolean`        | Clear one subject's counter.             |
| `health()`                          | `{ ok, ... }`    | Liveness + counts.                       |

### State shapes (opaque to the provider)

Counter `state` is algorithm-specific and opaque — persist and return it verbatim:

```jsonc
// fixed_window
{ "windowStart": 1706000000000, "count": 7 }
// sliding_window
{ "entries": [ { "t": 1706000000000, "cost": 1 } ] }
// token_bucket
{ "tokens": 42.5, "lastRefill": 1706000000000 }
// leaky_bucket
{ "level": 3.0, "lastLeak": 1706000000000 }
```

Policy `model` carries a `checksum` the engine owns — round-trip it verbatim; never
recompute it.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Per namespace, a `policies` map
  and a `counters` map. Single-process. Ideal for tests and single-node deployments.

## Future extension points (declared, not implemented)

`redis`, `storage` (Enterprise Storage Platform, ADR-021), `postgresql`, `mongodb`,
`custom`.

```js
const { futureProvider } = require('../../src/application/ratelimit/providerPort');
const p = futureProvider('redis'); // { planned: true, ... }
p.putCounter('ns', 'k', {}); // throws: "extension point — not implemented in Phase 15.2"
```

## Writing a new provider

1. Implement the contract above; deep-copy models/state in and out to avoid aliasing.
2. Map not-found to `null` (never throw for a missing policy/counter).
3. Keep it behavior-free — no evaluation/decay/admission/events. The engine owns those.
4. For a distributed store (Redis/Postgres), prefer an atomic read-modify-write for
   `putCounter` on the hot path; the in-process engine already serializes per
   (policy, subject), but cross-node atomicity is the provider's responsibility if you run
   the kernel on multiple nodes.
5. Wire it in the composition root: `createRateLimitPlatform({ provider: myProvider })`.

## Guarantees the engine relies on

- **Round-trip fidelity** — a policy/counter read back equals what was written
  (deep-copied), including the policy `checksum`.
- **Isolation** — namespaces and counter keys never bleed into each other.
