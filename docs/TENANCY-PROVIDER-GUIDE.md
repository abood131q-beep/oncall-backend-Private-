# Enterprise Multi-Tenancy Kernel — Provider Guide (ADR-038 §4)

A Multi-Tenancy provider **stores tenant definitions only**. It never resolves, builds
context, evaluates capability, manages lifecycle, or emits events — all of that lives in
the engine, so engine behavior is identical regardless of which provider is active. This is
the seam a future PostgreSQL / Storage / Redis / MongoDB / cloud-registry adapter slots
behind.

## Contract

Implement every method (all async unless noted). `assertProvider` fails fast at composition
time if any is missing.

| Method                                       | Returns         | Notes                                  |
| -------------------------------------------- | --------------- | -------------------------------------- |
| `name`                                       | `string`        | Non-empty adapter name.                |
| `putTenant(namespace, model)`                | `void`          | Upsert a tenant by `tenantId`; index by name. |
| `getTenant(namespace, tenantId)`             | `model \| null` | A tenant, or `null`.                   |
| `getTenantByName(namespace, tenantName)`     | `model \| null` | Resolve by unique name, or `null`.     |
| `listTenants(namespace)`                     | `model[]`       | All tenants in the namespace.          |
| `removeTenant(namespace, tenantId)`          | `boolean`       | `true` if removed (also drop the name index). |
| `health()`                                   | `{ ok, ... }`   | Liveness + counts.                     |

### Tenant model shape (opaque to the provider)

```jsonc
{
  "tenantId": "tnt_...",
  "namespace": "default",
  "tenantName": "acme",
  "tenantStatus": "active",       // pending | active | inactive | suspended
  "isolationLevel": "strict",     // strict | shared | dedicated
  "configRef": "cfg-acme", "policyRef": "pol-acme", "ownerRef": "user-42",
  "metadata": {}, "labels": {}, "capabilities": ["premium"],
  "checksum": "<sha256 hex>",     // engine-owned; round-trip verbatim
  "createdAt": 0, "updatedAt": 0, "version": 1
}
```

The provider treats the model as opaque: round-trip every field (deep copies to avoid
aliasing), never recompute the `checksum`, and never mutate. Maintain a unique name index so
`getTenantByName` is O(1). The checksum includes `tenantStatus`, so lifecycle transitions
persist as new checksums.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Per namespace, a `tenantId →
  model` map plus a `tenantName → tenantId` index. Single-process.

## Future extension points (declared, not implemented)

`postgresql`, `storage` (Enterprise Storage Platform, ADR-021), `redis`, `mongodb`,
`cloud-registry`, `custom`.

```js
const { futureProvider } = require('../../src/application/tenancy/providerPort');
const p = futureProvider('postgresql'); // { planned: true, ... }
p.putTenant('ns', {}); // throws: "extension point — not implemented in Phase 15.9"
```

## Writing a new provider

1. Implement the contract above; deep-copy models in and out.
2. Enforce unique `tenantName` per namespace (return the existing on name lookup).
3. Map not-found to `null` (never throw for a missing tenant).
4. Keep it behavior-free — no resolution/context/capability/lifecycle/events. The engine
   owns those. Persist and return the `checksum` verbatim.
5. Never share rows across namespaces — strict namespace isolation is a persistence
   guarantee the engine relies on.
6. Wire it in the composition root: `createTenancyPlatform({ provider: myProvider })`.

## Guarantees the engine relies on

- **Round-trip fidelity** — a tenant read back equals what was written (deep-copied),
  including `checksum`.
- **Isolation** — namespaces never bleed into each other; that is the foundation of tenant
  isolation.
