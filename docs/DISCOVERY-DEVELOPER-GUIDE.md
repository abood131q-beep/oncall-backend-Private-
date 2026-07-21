# Enterprise Service Discovery Kernel — Developer Guide (ADR-034)

The Service Discovery Kernel is the platform's unified abstraction for deterministic
registration, discovery, capability lookup, health-aware endpoint selection, and service
metadata management. It is **not Consul/etcd/Kubernetes/DNS** — those are provider
extension points. It lives under `discovery/`, additive to every existing kernel.

## 1. Compose

```js
const { createDiscoveryPlatform } = require('../../src/application/discovery');
const dk = createDiscoveryPlatform({
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
});
const D = dk.discovery;
```

## 2. Register a service instance

```js
const svc = await D.register({
  serviceName: 'trips', // logical service
  instanceId: 'trips-abc', // unique instance (auto-generated if omitted)
  endpoint: 'http://10.0.0.7:8080',
  protocol: 'http',
  version: '2.3.0', // semver
  capabilities: ['book', 'cancel'],
  tags: ['prod', 'us-east'],
  healthStatus: 'healthy', // healthy | degraded | failed | unknown
  priority: 10, // higher tiers win in resolve
  weight: 5, // weighted selection within a tier
  metadata: { zone: 'a' },
});
// → public service model (includes checksum). Re-registering the same serviceId updates it.
```

## 3. Discover (all matching instances)

```js
const res = await D.discover({
  serviceName: 'trips', // optional — omit to match across services
  version: '>=2.0.0', // semver range or exact
  capabilities: ['cancel'], // must all be present
  tags: ['prod'],
  metadata: { zone: 'a' },
  healthyOnly: true, // only healthy instances
});
// → { namespace, query, count, candidates: [...ordered by priority desc, weight desc] }
```

## 4. Resolve (one health-aware endpoint)

```js
const r = await D.resolve({ serviceName: 'trips', version: '>=2.0.0', key: 'user-123' });
// → { namespace, selected, explanation: { reason, candidateCount, tierSize, priority, bucket, totalWeight } }
```

Resolution excludes `failed` instances, picks the highest-priority tier, and within it
selects **deterministically** by weight using the stable `key` (same key → same instance).
With no available instance it emits `ServiceUnavailable` and throws `ServiceNotFoundError`.

## 5. List + verify + health

```js
await D.list({ namespace }); // → all service models
await D.verify({ namespace }); // → { ok, issues } — endpoint + checksum integrity
await D.health(); // → provider health + counts + cache stats + metrics
```

## 6. Events (through the port only)

`ServiceRegistered`, `ServiceUpdated`, `ServiceResolved`, `ServiceUnavailable`,
`DiscoveryVerified` — all via the Event Backbone, producer `discovery`.

## 7. Observability

```js
dk.metrics.snapshot(); // registeredServices, registeredInstances (gauges), discoveries,
// cacheHits/Misses, healthChanges, providerFailures, resolution latency, uptime
dk.metrics.prometheus();
```

## 8. SDK integration (ADR-018)

```js
const { toDiscoveryPort } = require('../../src/application/discovery/sdkAdapter');
const portFactories = {
  'discovery:read': () => toDiscoveryPort(dk.discovery, { owner: extId, canResolve: false }),
  'discovery:resolve': () => toDiscoveryPort(dk.discovery, { owner: extId }),
};
// Inside the extension: this.discovery().resolve({ serviceName, key })
```

Every call is forced into the extension's namespace (`ext.<owner>`). `discover`/`list`/
`verify` require `discovery:read`; `resolve` requires `discovery:resolve`. Service
registration is administrative and not exposed to extensions.

## 9. Determinism, selection & integrity

- **Deterministic** — matching + ordering are pure; weighted selection hashes
  `serviceName:key`, so the same key always resolves to the same instance and ramps of
  weight shift traffic predictably.
- **Health-aware** — `resolve` never returns a `failed` instance; `healthyOnly` narrows to
  `healthy` only.
- **Version-aware** — `version` accepts a semver range (`>=2.0.0`) or an exact version.
- **Integrity** — every service carries a checksum over its definition (endpoint included);
  `verify()` recomputes it and confirms the endpoint is well-formed. Health updates do not
  change the checksum.

## Out of scope (future work behind the provider port)

Real registries (Consul/etcd/Kubernetes/DNS/cloud), active health-checking, and TTL-based
instance expiry are declared extension points, not implemented in this phase. The memory
provider + cache are single-process.
