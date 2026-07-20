# Enterprise Storage — Developer Guide (Phase 14.3.4)

The Storage Kernel abstracts every persistence technology behind one Port. It is **not an
ORM** and **not coupled to any database**. Every Platform Service and Extension persists
through this abstraction; no consumer knows which provider is active.

## 1. Compose

```js
const { createStoragePlatform, providers } = require('../../src/application/storage');

const st = createStoragePlatform({
  provider: providers.createMemoryProvider(), // or createFileProvider({ path })
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
  writeThrough: true, // cache option (default on)
});
const s = st.storage;
```

## 2. Records

A record holds a `value` (document, key-value, or binary `Buffer`/`Uint8Array`), plus
`metadata`, a monotonic `version`, `contentType`, timestamps, and optional TTL. It lives in a
`namespace` (isolation boundary) and a `collection` (logical group, default `"default"`).

## 3. CRUD

```js
await s.put({ namespace: 'orders', collection: 'active', key: 'o1', value: { total: 10 } });
await s.get({ namespace: 'orders', collection: 'active', key: 'o1' }); // record model | null
await s.exists({ namespace: 'orders', key: 'o1' });
await s.update({ namespace: 'orders', key: 'o1', value: { total: 12 }, expectedVersion: 1 });
await s.delete({ namespace: 'orders', key: 'o1' });
```

`put` upserts (creates v1 or replaces, version+1). `update` requires the key to exist and
supports **optimistic locking** via `expectedVersion` (a mismatch throws `ConcurrencyError`).

## 4. Query + list

```js
await s.list({ namespace: 'orders', collection: 'active', prefix: 'o' });
await s.query({
  namespace: 'orders',
  where: { total: { op: 'gte', value: 10 }, status: 'open' },
  sort: { field: 'total', dir: 'desc' },
  limit: 20,
  offset: 0,
});
```

Operators: `eq, ne, gt, gte, lt, lte, in, contains, exists`. Matching is over the record's
`value` (dotted paths) plus reserved `key`/`collection` and `metadata.*`.

## 5. TTL + versioning

Pass `ttlMs` on `put`/`update`; expired records are treated as absent and purged lazily on
access. Every mutation bumps `version`; use it with `expectedVersion` for safe concurrent
edits.

## 6. Transactions + batch

```js
await s.transaction(async (tx) => {
  await tx.put({ namespace: 'n', key: 'a', value: 1 });
  await tx.update({ namespace: 'n', key: 'b', value: 2, expectedVersion: 3 });
  await tx.delete({ namespace: 'n', key: 'c' });
}); // commits atomically; throwing anywhere rolls back the whole set

await s.batch([
  { op: 'put', namespace: 'n', key: 'x', value: 1 },
  { op: 'delete', namespace: 'n', key: 'y' },
]);
```

Commit is atomic (single provider `writeBatch`); any throw rolls back with nothing persisted.
Nested transactions are rejected.

## 7. Events (through the port only)

`StorageCreated`, `StorageUpdated`, `StorageDeleted`, `TransactionCommitted`,
`TransactionRolledBack`, `StorageProviderChanged` — all via the EventPublisher port, producer
`storage`. The EventBus is never exposed.

## 8. Observability + health

```js
st.metrics.snapshot(); // reads/writes/updates/deletes/transactions, latency, cache ratios
st.metrics.prometheus(); // Prometheus exposition
await s.health(); // { ok, provider, metrics, cache }
```

## 9. SDK integration (ADR-018)

```js
const { toStoragePort } = require('../../src/application/storage/sdkAdapter');

const portFactories = {
  'storage:read': () => toStoragePort(st.storage, { owner: extId, canWrite: false }),
  'storage:write': () => toStoragePort(st.storage, { owner: extId }),
};
// Inside the extension: this.storage().put({ key, value }) — the namespace is forced to
// the extension's own; it can never read or write another extension's data.
```

Writes require the `storage:write` capability, reads require `storage:read`; missing
capability throws a `PermissionError`.

## Out of scope (by mandate)

Not an ORM; no coupling to a specific database; durable providers (SQLite/Postgres/…),
cross-process transactions, and secondary indexes are future work behind the provider port.
