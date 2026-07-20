# Policy Platform — Provider Guide (ADR-025)

A **provider** is a policy-**definition** store for one technology. It persists definitions and
performs **no evaluation** (the engine decides). Business logic never imports a provider; the
composition root wires it behind the port.

## The provider port

`src/application/policy/providerPort.js`:

```js
{
  name,                                 // string id
  put(namespace, policyModel) -> void,
  get(namespace, policyId) -> policyModel | null,
  remove(namespace, policyId) -> boolean,
  list(namespace) -> policyModel[],
  health() -> { ok, ... },
}
```

`assertProvider(p)` fails fast if any method or `name` is missing. The `policyModel` is the
policy's serializable form (`toModel()`): identity, scope, priority, effect, state, metadata,
and checksum. Data-only conditions travel in the model; custom `fn` conditions are runtime-only
(in-process) and are not persisted.

## Implemented adapter

### Memory — `createMemoryProvider({ name? })`

In-process `Map<namespace, Map<policyId, model>>`. Single process; the seam a future OPA/Cedar/
Casbin definition store slots behind. The service keeps live policy entities for evaluation and
mirrors their models here for persistence.

## Extension points (declared, not implemented in this phase)

`FUTURE_PROVIDERS`: `opa`, `cedar`, `casbin`, `custom`. `futureProvider(name)` returns a guard
whose operations throw a clear "extension point — not implemented" error. Such a provider would
**store** OPA/Cedar/Casbin definitions; evaluation would still be performed by this engine (or,
in a future phase, delegated — but consistency and default-deny remain the engine's contract).

## Writing a new provider (e.g. a durable store)

```js
function createStorageBackedProvider({ storage }) {
  const NS = 'policy';
  return {
    name: 'storage',
    async put(namespace, model) {
      await storage.put({ namespace: NS, collection: namespace, key: model.policyId, value: model });
    },
    async get(namespace, policyId) {
      const r = await storage.get({ namespace: NS, collection: namespace, key: policyId });
      return r ? r.value : null;
    },
    async remove(namespace, policyId) {
      return storage.delete({ namespace: NS, collection: namespace, key: policyId });
    },
    async list(namespace) {
      return (await storage.list({ namespace: NS, collection: namespace })).map((r) => r.value);
    },
    health: () => ({ ok: true, provider: 'storage' }),
  };
}
```

Then pass it as `createPolicyPlatform({ provider })`. No business-logic changes; evaluation is
unchanged because it lives in the engine.

## Guarantees the engine adds on top of any provider

Deterministic default-deny evaluation, ordered conflict resolution, decision caching, integrity
verification, lifecycle events, and metrics — so providers stay simple and swappable.
