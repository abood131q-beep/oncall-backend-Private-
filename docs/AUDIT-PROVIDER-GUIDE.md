# Audit Platform — Provider Guide (ADR-026)

A **provider** is an **append-only** record store for one technology. It persists immutable
audit records and performs **no** integrity verification and **no** query logic — the engine
owns both. Business logic never imports a provider; the composition root wires it behind the
port. There is deliberately no update or delete surface.

## The provider port

`src/application/audit/providerPort.js`:

```js
{
  name,                                 // string id
  append(namespace, record) -> void,    // append one immutable record
  scan(namespace) -> record[],          // all records, in append order
  get(namespace, auditId) -> record | null,
  count(namespace) -> number,
  tail(namespace) -> record | null,     // most recent (used for chain linkage)
  health() -> { ok, ... },
}
```

`assertProvider(p)` fails fast if any method or `name` is missing. Records arrive already frozen
(immutable) and already checksummed/chained by the engine; the provider treats them as opaque
append entries. The engine calls `tail()` before each append to link the hash chain, so a
provider must return records in stable append order.

## Implemented adapter

### Memory — `createMemoryProvider({ name? })`

In-process append log (`namespace → { list, byId }`). Single process; the seam a durable
append log slots behind. No update/delete.

## Extension points (declared, not implemented in this phase)

`FUTURE_PROVIDERS`: `storage`, `postgres`, `mongodb`, `object-storage`. `futureProvider(name)`
returns a guard whose operations throw a clear "extension point — not implemented" error.

## Writing a new provider (e.g. Storage-kernel backed)

```js
function createStorageAuditProvider({ storage }) {
  const NS = 'audit';
  return {
    name: 'storage',
    async append(namespace, record) {
      // key by zero-padded sequence to preserve append order on scan
      const key = `${String(record.sequence).padStart(12, '0')}:${record.auditId}`;
      await storage.put({ namespace: NS, collection: namespace, key, value: record });
    },
    async scan(namespace) {
      return (await storage.list({ namespace: NS, collection: namespace })).map((r) => r.value);
    },
    async get(namespace, auditId) {
      const all = await this.scan(namespace);
      return all.find((r) => r.auditId === auditId) || null;
    },
    count() {
      /* provider-specific */
    },
    tail() {
      /* most-recent by sequence */
    },
    health: () => ({ ok: true, provider: 'storage' }),
  };
}
```

Then pass it as `createAuditPlatform({ provider })`. Integrity and query are unchanged because
they live in the engine.

> Note: durable retention/rotation, WORM object-storage backends, and cross-shard chains are
> designed into the adapter + engine in a later phase. The memory provider is single-process.

## Guarantees the engine adds on top of any provider

Immutable, checksummed records; a per-namespace hash chain; full integrity verification
(checksum + linkage + sequence); deterministic query/timeline; lifecycle events; and metrics —
so providers stay simple, append-only, and swappable.
