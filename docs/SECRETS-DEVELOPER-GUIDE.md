# Enterprise Secrets Kernel — Developer Guide (ADR-028)

The Secrets Kernel is the platform's unified abstraction for sensitive configuration and
credentials. It is **not a password manager** and **not Vault/AWS Secrets Manager/Azure
Key Vault/GCP Secret Manager** — those are provider extension points. It lives under
`secrets/`, additive to every existing kernel.

## 1. Compose

```js
const { createSecretsPlatform } = require('../../src/application/secrets');
const sk = createSecretsPlatform({
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
  valueFactory, // optional — generates a value on rotate() when none is supplied
});
const S = sk.secrets;
```

## 2. Store a secret (creates version 1)

```js
const pub = await S.store({
  name: 'db.password', // unique per namespace
  value: 's3cr3t', // the protected value (string)
  metadata: { owner: 'platform' },
  tags: ['db', 'prod'],
  rotationPolicy: { enabled: true, intervalMs: 2592000000, maxVersions: 5 },
});
// → public model — value is REDACTED ('***REDACTED***'); NEVER the plaintext
```

Storing a name that already exists throws `SecretValidationError` (use `rotate`).

## 3. Resolve — the only value-revealing call

```js
const cur = await S.resolve({ name: 'db.password' }); // current version
const v1 = await S.resolve({ name: 'db.password', version: 1 }); // a specific version
// → { secretId, name, namespace, version, value, metadata, tags, state, createdAt, updatedAt }
```

Resolution is deterministic (same name + version → same value) and verifies integrity
before returning; a tampered value throws `IntegrityError`. An unknown or deleted secret
throws `SecretNotFoundError`.

## 4. Rotate — new version, validated

```js
await S.rotate({ name: 'db.password', value: 'n3w-s3cr3t' });
// or, with a configured valueFactory, omit the value to auto-generate one:
await S.rotate({ name: 'db.password' });
```

Rotation validation rejects: a missing value (with no `valueFactory`), a no-op rotation to
the identical value, and rotation of an unknown/deleted secret. Prior versions remain
resolvable by version number.

## 5. Delete + list

```js
await S.delete({ name: 'db.password' }); // → true (idempotent: false if already gone)
await S.list(); // → public (redacted) models in the namespace
```

## 6. Events (through the port only)

`SecretStored`, `SecretResolved`, `SecretRotated`, `SecretDeleted` — all via the Event
Backbone, producer `secrets`. **No event carries a secret value** (only id/name/namespace/
version). The EventBus is never exposed.

## 7. Observability

```js
sk.metrics.snapshot(); // stored, storedSecrets (gauge), rotations, resolutions,
// deletions, providerFailures, integrityFailures, rotation latency, uptime
sk.metrics.prometheus();
await S.health();
```

## 8. SDK integration (ADR-018)

```js
const { toSecretsPort } = require('../../src/application/secrets/sdkAdapter');
const portFactories = {
  'secrets:read': () => toSecretsPort(sk.secrets, { owner: extId, canWrite: false }),
  'secrets:write': () => toSecretsPort(sk.secrets, { owner: extId }),
};
// Inside the extension: this.secrets().store({ name, value })
```

Every call is forced into the extension's namespace (`ext.<owner>`), so an extension can
only read/write its own secrets. `store/rotate/delete` require `secrets:write`;
`resolve/list` require `secrets:read`.

## 9. Integrity, verification & diagnostics

```js
await S.snapshotSecret(namespace, name); // deep-frozen, value REDACTED
S.verifyStartup(); // { ok, problems }
await S.verifyProvider(namespace); // every indexed secret resolves
await S.verifyIntegrity(namespace); // every stored value matches its checksum
S.diagnostics(namespace); // secrets/namespaces/startup/metrics
S.history(); // bounded lifecycle log
```

## Security

Values are stored with a sha256 integrity fingerprint and are only ever returned by an
explicit `resolve()`; every other surface (store/rotate/list/events/diagnostics/snapshots)
redacts them to a constant token. Namespace isolation and capability gates are enforced at
the SDK boundary. Rotation is validated. Integrity is verified on every resolve and on
demand across a namespace.

## Out of scope (future work behind the provider port)

Real store integrations (Vault/AWS/Azure/GCP), envelope encryption / KMS-backed ciphertext
at rest, and automated rotation scheduling are declared extension points, not implemented
in this phase. The memory provider is single-process. This is not a password manager.
