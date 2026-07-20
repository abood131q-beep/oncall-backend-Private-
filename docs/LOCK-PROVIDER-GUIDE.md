# Lock Platform — Provider Guide (Phase 14.3.5)

A **provider** is a dumb lock-record store for one backend. It performs no lease, ownership,
or conflict logic and emits no events — those live in the Lock service/domain. Business logic
never imports a provider; the composition root wires it behind the port.

## The provider port

`src/application/lock/providerPort.js`:

```js
{
  name,                                       // string id
  async read(namespace, lockId) -> model | null,
  async write(namespace, lockId, model) -> void,
  async remove(namespace, lockId) -> boolean,
  async scan(namespace) -> model[],
  health() -> { ok, ... },
}
```

`assertProvider(p)` fails fast if any method or `name` is missing. The `model` is the lock's
serializable form (`toModel()`); providers treat it as opaque data.

## Implemented adapter

### Memory — `createMemoryProvider({ name? })`

Single-process `Map<namespace, Map<lockId, model>>`, cloning on read/write so the store can't
be mutated by reference. Ideal for tests and single-node deployments. **Not distributed** — a
second process has its own store.

## Extension points (declared, not implemented in this phase)

`FUTURE_PROVIDERS`: `redis`, `postgres-advisory`, `mysql`, `zookeeper`, `etcd`, `consul`.
`futureProvider(name)` returns a guard whose operations reject with a clear "extension point —
not implemented" error, so intent is explicit and a half-wired provider fails loudly.

## Writing a new provider (e.g. Redis)

```js
function createRedisLockProvider({ client }) {
  const nk = (ns, id) => `lock:${ns}:${id}`;
  return {
    name: 'redis',
    async read(ns, id) {
      const raw = await client.get(nk(ns, id));
      return raw ? JSON.parse(raw) : null;
    },
    async write(ns, id, model) {
      await client.set(nk(ns, id), JSON.stringify(model));
    },
    async remove(ns, id) {
      return (await client.del(nk(ns, id))) > 0;
    },
    async scan(ns) {
      /* SCAN lock:ns:* → JSON.parse each */
    },
    health: () => ({ ok: true, provider: 'redis' }),
  };
}
```

Then pass it as `createLockPlatform({ provider })`, or swap at runtime with
`lock.useProvider(p)`. No business-logic changes.

> Note: a distributed backend can *store* locks, but the service's guarantees here are
> single-process (serialized mutations + injected clock). True cross-process consensus,
> fencing tokens, and clock-skew handling are out of scope for Phase 14.3.5 and would be
> designed into the provider + service in a later phase.

## Guarantees the service adds on top of any provider

Lease expiration + automatic settlement, ownership validation, conflict detection, reentrant
same-owner acquisition, lifecycle events, and metrics — so providers stay simple and swappable.
