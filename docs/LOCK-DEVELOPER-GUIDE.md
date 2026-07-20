# Enterprise Lock — Developer Guide (Phase 14.3.5)

The Lock Kernel is the platform-wide locking abstraction. It is **not a mutex library** and
**not tied to Redis or a database**. Every Platform Service and Extension locks through this
Port; no consumer knows which provider is active. It is **in-process** — not distributed
coordination.

## 1. Compose

```js
const { createLockPlatform, providers } = require('../../src/application/lock');

const lk = createLockPlatform({
  provider: providers.createMemoryProvider(), // default
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
});
const L = lk.lock;
```

## 2. The lock model

A lock lives in a `namespace` under a `lockId`, held by an `ownerId` for a lease of `leaseMs`.
It carries `metadata`, a monotonic `version`, and a lifecycle `state`
(`available → acquired ⇄ renewing → released | expired | failed`).

## 3. Port

```js
await L.tryAcquire({ namespace: 'trips', lockId: 't1', ownerId: 'svc-a', leaseMs: 30000 });
// → lock model, or null if held by another owner

await L.acquire({ namespace: 'trips', lockId: 't1', ownerId: 'svc-a', waitMs: 2000 });
// → blocks up to waitMs (polling), or throws LockConflictError

await L.renew({ namespace: 'trips', lockId: 't1', ownerId: 'svc-a', leaseMs: 30000 });
await L.release({ namespace: 'trips', lockId: 't1', ownerId: 'svc-a' });

await L.isHeld({ namespace: 'trips', lockId: 't1' }); // boolean
await L.owner({ namespace: 'trips', lockId: 't1' }); // ownerId | null
await L.health();
```

`acquire` throws `LockConflictError` on conflict; `tryAcquire` returns `null`. Re-acquiring as
the **same owner** is reentrant and refreshes the lease.

## 4. Leases, renewal, expiry

A lease expires at `acquiredAt + leaseMs`. Expiry is settled deterministically on the next
access: once past expiry the lock becomes `available` (a `LockExpired` event is published) and
another owner may acquire it. Renew before expiry to keep the lease; renewing or releasing as a
non-owner throws `OwnershipError`.

## 5. Conflict detection

If a live lease is held by another owner, `tryAcquire` returns `null` and a `LockConflict`
event is published (`acquire` throws). Mutations are serialized internally, so two concurrent
acquisitions on the same lock grant to exactly one owner.

## 6. Events (through the port only)

`LockAcquired`, `LockReleased`, `LockExpired`, `LockRenewed`, `LockConflict` — all via the
EventPublisher port, producer `lock`. The EventBus is never exposed.

## 7. Observability

```js
lk.metrics.snapshot(); // acquired/released/renewals/expirations/conflicts, avg lease, latency
lk.metrics.prometheus(); // Prometheus exposition
```

## 8. SDK integration (ADR-018)

```js
const { toLockPort } = require('../../src/application/lock/sdkAdapter');

const portFactories = {
  'lock:read': () => toLockPort(lk.lock, { owner: extId, canWrite: false }),
  'lock:write': () => toLockPort(lk.lock, { owner: extId }),
};
// Inside the extension, e.g. this.lock():
//   await this.lock().tryAcquire({ lockId: 'resource-1' })
```

The adapter forces `ownerId` and the namespace to the extension's identity — an extension can
never acquire under another owner or touch another extension's locks. Write ops require
`lock:write`, reads require `lock:read`; missing capability throws `PermissionError`.

## Out of scope (by mandate)

No distributed coordination/consensus, no cross-process fencing tokens, no fair-queue
acquisition — those are future work behind the provider port.
