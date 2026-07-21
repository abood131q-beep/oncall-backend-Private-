# Enterprise Resource Management Kernel — Developer Guide (ADR-039)

The Resource Management Kernel is the platform's unified abstraction for deterministic
resource allocation, capacity governance, quota orchestration, and lifecycle management. It
is **not Kubernetes ResourceQuota / Linux cgroups / Docker resource limits / a cloud
autoscaler** — those are infrastructure controls. It lives under `resources/`, additive to
every existing kernel.

## 1. Compose

```js
const { createResourcePlatform } = require('../../src/application/resources');
const rk = createResourcePlatform({ publisher }); // EventPublisher port (ADR-016)
const R = rk.resources;
```

## 2. Register a resource

```js
const r = await R.registerResource({
  resourceType: 'cpu-cores',
  capacity: 100, // total units
  reservation: 20, // headroom kept unallocatable (allocatable = capacity - reservation)
  quota: 40, // optional per-owner cap
  priority: 0,
  labels: { pool: 'compute' },
});
// → resource model (capacity/allocated/available/quota/reservation/checksum)
```

## 3. Allocate + release

```js
const a = await R.allocate({
  resourceId: r.resourceId,
  amount: 10,
  owner: 'trips', // quota is tracked per owner
  priority: 5, // higher priority can preempt lower-priority allocations
});
// → allocation record { allocationId, resourceId, owner, amount, priority, status: 'active' }
await R.release({ allocationId: a.allocationId }); // → true
```

Allocation is deterministic and atomic per resource — concurrent requests never
over-commit. On insufficient capacity the engine **preempts** strictly-lower-priority
allocations (emitting `ResourceReleased` with `preempted: true`) until there is room; if it
still cannot fit, it throws `ResourceConflictError`. Exceeding a per-owner quota throws
`QuotaExceededError` and emits `QuotaExceeded`.

## 4. Query accounting

```js
const q = await R.query({ resourceId: r.resourceId });
// → { capacity, allocated, available, allocatable, reservation, quota, utilization,
//     status, activeAllocations }
```

## 5. Verify + health

```js
await R.verify({ namespace }); // → { ok, issues } — checksum integrity + accounting drift
await R.health();
```

`verify` recomputes each resource's checksum AND confirms `allocated` equals the sum of its
active allocations (accounting consistency).

## 6. Events (through the port only)

`ResourceRegistered`, `ResourceAllocated`, `ResourceReleased`, `QuotaExceeded`,
`ResourceUpdated`, `ResourceVerified` — all via the Event Backbone, producer `resources`.

## 7. Observability

```js
rk.metrics.snapshot(); // registered resources + active allocations (gauges), released,
// allocations, quotaViolations, conflicts, preemptions, resourceUtilization, latency, uptime
rk.metrics.prometheus();
```

## 8. SDK integration (ADR-018)

```js
const { toResourcePort } = require('../../src/application/resources/sdkAdapter');
const portFactories = {
  'resource:read': () => toResourcePort(rk.resources, { owner: extId, canAllocate: false }),
  'resource:allocate': () => toResourcePort(rk.resources, { owner: extId }),
};
// Inside the extension: this.resources().allocate({ resourceId, amount })
```

Every call is forced into the extension's namespace (`ext.<owner>`) and allocations are
stamped with the extension owner. `allocate`/`release` require `resource:allocate`;
`query`/`verify`/`list` require `resource:read`. Resource authoring (`registerResource`) is
administrative and not exposed to extensions.

## Determinism, governance & integrity

- **Deterministic** — an injected clock drives timestamps; the same allocation sequence
  always produces the same accounting and preemption decisions.
- **No over-commit** — a per-resource serialization mutex ensures concurrent allocations
  never exceed `allocatable` (verified: 20 concurrent unit requests against capacity 10
  grant exactly 10).
- **Reservation** — kept as headroom: allocatable = capacity − reservation.
- **Quota** — enforced per owner from the active allocation set.
- **Preemption** — a higher-priority request reclaims strictly-lower-priority allocations
  deterministically (lowest priority, then oldest, first).
- **Integrity** — every resource + allocation carries a checksum; `verify()` also detects
  accounting drift.

## Out of scope (future work behind the provider port)

Real stores (PostgreSQL/Storage/Redis/MongoDB/cloud), fair-share/weighted scheduling, and
time-based leases/expiry are declared extension points, not implemented in this phase. The
memory provider is single-process.
