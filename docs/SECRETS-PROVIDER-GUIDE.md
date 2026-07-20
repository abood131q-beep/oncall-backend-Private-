# Enterprise Secrets Kernel — Provider Guide (ADR-028 §4)

A Secrets provider **stores secret + version models only**. It performs no secret
behavior — no rotation, no redaction, no integrity verification, no events. All of that
lives in the engine, so engine behavior is identical regardless of which provider is
active. This is the seam a future Vault / AWS Secrets Manager / Azure Key Vault / GCP
Secret Manager adapter slots behind.

## Contract

Implement every method (all async unless noted). `assertProvider` fails fast at
composition time if any is missing.

| Method                                        | Returns          | Notes                                             |
| --------------------------------------------- | ---------------- | ------------------------------------------------- |
| `name`                                        | `string`         | Non-empty adapter name.                           |
| `putSecret(namespace, model)`                 | `void`           | Upsert the current model **and** append its version. |
| `getSecret(namespace, name)`                  | `model \| null`  | The current (latest) version.                     |
| `getSecretVersion(namespace, name, version)`  | `model \| null`  | A specific historical version.                    |
| `listSecrets(namespace)`                      | `model[]`        | Current version of each secret in the namespace.  |
| `listVersions(namespace, name)`               | `number[]`       | Ascending version numbers.                         |
| `removeSecret(namespace, name)`               | `boolean`        | `true` if a secret was removed.                   |
| `health()`                                    | `{ ok, ... }`    | Liveness + counts.                                |

### Model shape (opaque to the provider)

```jsonc
{
  "secretId": "sec_...",
  "name": "db.password",
  "namespace": "default",
  "version": 3,
  "value": "…",            // provider persists as-is; the engine owns redaction
  "valueChecksum": "<sha256 hex>",
  "metadata": {},
  "tags": [],
  "rotationPolicy": { "enabled": true, "intervalMs": 0, "maxVersions": 0 },
  "createdAt": 0,
  "updatedAt": 0,
  "state": "active"          // active | deprecated | deleted
}
```

The provider treats the model as opaque. It must round-trip every field (deep copies to
avoid aliasing) and preserve historical versions so `getSecretVersion` and `listVersions`
stay correct across rotations.

## Implemented adapter

- **memory** (`providers/memoryProvider.js`) — in-process. Per namespace, keeps a map of
  `name → { current, versions: Map(version → model) }`. Single-process; values live in
  memory. Ideal for tests and single-node deployments.

## Future extension points (declared, not implemented)

`vault`, `aws-secrets-manager`, `azure-key-vault`, `gcp-secret-manager`, `custom`.

```js
const { futureProvider } = require('../../src/application/secrets/providerPort');
const p = futureProvider('vault'); // { planned: true, ... }
p.putSecret('ns', {}); // throws: "extension point — not implemented in Phase 14.9"
```

## Writing a new provider

1. Implement the contract above; deep-copy models in and out.
2. Persist both the current version and the full version history.
3. Map your backend's not-found to `null` (never throw for a missing secret).
4. Keep it behavior-free — no rotation/redaction/integrity/events. The engine owns those.
5. For a KMS-backed store, persist ciphertext under `value`; the engine's checksum is over
   whatever string you round-trip, so encrypt/decrypt consistently at the provider edge.
6. Wire it in the composition root: `createSecretsPlatform({ provider: myProvider })`.

## Guarantees the engine relies on

- **Round-trip fidelity** — a model read back equals what was written (deep-copied).
- **Version immutability** — a stored version is never mutated by later writes.
- **Deterministic reads** — `getSecretVersion(ns, name, v)` always returns the same model.
- **Isolation** — namespaces never bleed into each other.
