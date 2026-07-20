# Storage Platform — Provider Guide (Phase 14.3.4)

A **provider** is a dumb record store for one persistence technology. It performs no
versioning, TTL, events, or business logic — those live in the Storage service/domain.
Business logic never imports a provider; the composition root wires it behind the port.

## The provider port

`src/application/storage/providerPort.js`:

```js
{
  name,                                        // string id
  async read(namespace, key) -> record | null,
  async write(namespace, key, record) -> void,
  async remove(namespace, key) -> boolean,     // true if it existed
  async has(namespace, key) -> boolean,
  async scan(namespace) -> record[],           // all records in a namespace
  async writeBatch(ops) -> void,               // atomic: [{op:'put'|'del', namespace, key, record?}]
  health() -> { ok, ... },
}
```

`assertProvider(p)` fails fast if any method or `name` is missing. The service composes the
provider key from `${collection} ${key}`, so providers treat `key` as an opaque string.

## Implemented adapters

### Memory — `createMemoryProvider({ name? })`

In-process `Map<namespace, Map<key, record>>`. Clones records on read/write so the store
cannot be mutated by reference. `writeBatch` stages on a copy then commits (all-or-nothing).
Ideal for tests, caches, and as the seam a durable provider slots behind.

### File — `createFileProvider({ path, readFile?, writeFile? })`

Persists the whole store as one JSON document. Binary values are base64-encoded on write and
restored on read, so documents, key-value, and binary objects round-trip. File I/O is
injected (defaults to `fs` sync UTF-8), so it is testable without disk. `writeBatch` stages on
a deep copy then persists once (atomic single-file write).

## Extension points (declared, not implemented in this phase)

`FUTURE_PROVIDERS`: `sqlite`, `postgres`, `mysql`, `mongodb`, `redis`, `s3`, `azure-blob`,
`google-cloud-storage`. `futureProvider(name)` returns a guard whose operations reject with a
clear "extension point — not implemented" error, so intent is explicit and a half-wired
provider fails loudly.

## Writing a new provider

```js
function createRedisProvider({ client }) {
  const nk = (ns, key) => `st:${ns}:${key}`;
  return {
    name: 'redis',
    async read(ns, key) {
      const raw = await client.get(nk(ns, key));
      return raw ? JSON.parse(raw) : null;
    },
    async write(ns, key, record) {
      await client.set(nk(ns, key), JSON.stringify(record));
    },
    async remove(ns, key) {
      return (await client.del(nk(ns, key))) > 0;
    },
    async has(ns, key) {
      return (await client.exists(nk(ns, key))) > 0;
    },
    async scan(ns) {
      /* SCAN st:ns:* → JSON.parse each */
    },
    async writeBatch(ops) {
      /* MULTI/EXEC for atomicity */
    },
    health: () => ({ ok: true, provider: 'redis' }),
  };
}
```

Then pass it as `createStoragePlatform({ provider })`, or swap at runtime with
`storage.useProvider(p)` (emits `StorageProviderChanged`). No business-logic changes.

## Guarantees the service adds on top of any provider

Versioning, optimistic concurrency, TTL expiry, namespaces/collections, a read/write-through
cache, atomic transactions with rollback, lifecycle events, and metrics — so providers stay
simple and swappable.
