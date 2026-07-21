# Enterprise Compatibility Kernel — Provider Guide (ADR-041 §4)

A Compatibility provider **stores contract metadata only** — contract definitions keyed by
namespace. It never evaluates compatibility, negotiates capabilities, resolves versions,
enforces deprecation, or emits events — all of that lives in the engine, so engine behavior
is identical regardless of which provider is active. This is the seam a future PostgreSQL /
Storage / Redis / MongoDB / cloud-registry adapter slots behind.

## Contract

Implement every method (all async unless noted). `assertProvider` fails fast at composition
time if any is missing.

| Method                                     | Returns         | Notes                               |
| ------------------------------------------ | --------------- | ----------------------------------- |
| `name`                                     | `string`        | Non-empty adapter name.             |
| `putContract(namespace, model)`            | `void`          | Upsert a contract by `contractId`.  |
| `getContract(namespace, contractId)`       | `model \| null` | A contract, or `null`.              |
| `listContracts(namespace)`                 | `model[]`       | All contracts in the namespace.     |
| `removeContract(namespace, contractId)`    | `boolean`       | `true` if removed.                  |
| `health()`                                 | `{ ok, ... }`   | Liveness + counts.                  |

### Contract model shape (opaque to the provider)

```jsonc
{
  "contractId": "ctr_...",
  "namespace": "default",
  "component": "billing-api",
  "version": "2.1.0",
  "supportedVersions": ["1.0.0", "2.0.0", "2.1.0"],
  "capabilities": ["invoices", "refunds"],
  "compatibilityLevel": "backward",   // strict|backward|forward|full|none
  "deprecationStatus": "active",      // active|deprecated|retired
  "replacementContract": null,
  "metadata": {},
  "checksum": "<sha256 hex>",         // engine-owned; round-trip verbatim
  "createdAt": 0, "updatedAt": 0, "version_": 1
}
```

The provider treats the model as opaque: round-trip every field (deep copies to avoid
aliasing), never recompute the `checksum`, and never mutate. The checksum covers the full
definition including `deprecationStatus`, so a deprecation persisted verbatim stays
tamper-evident.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Per namespace, a `contractId →
  model` map. Single-process.

## Future extension points (declared, not implemented)

`postgresql`, `storage` (Enterprise Storage Platform, ADR-021), `redis`, `mongodb`,
`cloud-registry`, `custom`.

```js
const { futureProvider } = require('../../src/application/compatibility/providerPort');
const p = futureProvider('postgresql'); // { planned: true, ... }
p.putContract('ns', {}); // throws: "extension point — not implemented in Phase 15.12"
```

## Writing a new provider

1. Implement the contract above; deep-copy models in and out.
2. Map not-found to `null` (never throw for a missing contract).
3. Keep it behavior-free — no evaluation/negotiation/version-resolution/deprecation/events.
   The engine owns those. Persist and return the `checksum` and `deprecationStatus`
   verbatim so integrity verification and deprecation governance survive a restart.
4. For a shared store, `putContract` on a registration/deprecation should be atomic; the
   in-process engine serializes writes per namespace, but cross-node coordination is the
   provider's (or the Lock kernel's) responsibility.
5. Wire it in the composition root: `createCompatibilityPlatform({ provider: myProvider })`.

## Guarantees the engine relies on

- **Round-trip fidelity** — a contract read back equals what was written (deep-copied),
  including `checksum` and `deprecationStatus`.
- **Isolation** — namespaces never bleed into each other.
