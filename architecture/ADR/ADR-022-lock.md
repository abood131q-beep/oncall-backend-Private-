# ADR-022 — Enterprise Lock Platform

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-20
**Phase:** 14.3.5 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-020 (Scheduler), ADR-021 (Storage)

## Context

Platform Services and Extensions need mutual exclusion over named resources (a trip, a
scooter, a job) with leases, renewal, and expiry — without binding to a mutex library, Redis,
or a database. This is the Lock Kernel: one platform-wide locking abstraction, additive,
in-process, deterministic, provider-based, reachable only through a Port. **Not distributed
coordination** — that is explicitly out of scope.

## Decision

Add a self-contained, additive Lock Platform. Nothing in it is imported by a hot path, so the
platform runs byte-identically whether or not the lock platform is instantiated.

**Domain (pure):**

- `lock.js` — the Lock aggregate (identity `${namespace}/${lockId}`): lockId, ownerId,
  namespace, leaseMs, acquiredAt, expiresAt, renewedAt, metadata, version, state. Encapsulates
  its own **deterministic lifecycle**: `available → acquired ⇄ renewing → released | expired |
  failed`; `isLive(now)`, `settleExpiry(now)`.
- `errors.js` — `LockError`, `LockConflictError`, `OwnershipError`, `LeaseError`.
- `events.js` — self-contained lock event catalog (LockAcquired/Released/Expired/Renewed/
  Conflict); producer `lock`.

**Application (ports & adapters):**

- `providerPort.js` — the low-level `LockProvider` contract (`read/write/remove/scan/health`)
  + declared extension points (Redis, PostgreSQL advisory locks, MySQL, ZooKeeper, etcd,
  Consul). Providers are dumb lock-record stores — no lease/ownership logic, no events.
- `providers/memory.js` — the implemented single-process adapter.
- `metrics.js` — acquired/released/renewals/expirations/conflicts, average lease duration,
  latency; Prometheus.
- `lockPort.js` — the abstraction contract (`assertLock`).
- `lockService.js` — the kernel: `acquire/tryAcquire/renew/release/isHeld/owner/health` with
  lease expiration, automatic expiry settlement, ownership validation, and conflict
  detection. Mutations are serialized through an internal mutex so the read-check-write of an
  acquire is atomic — two acquires on the same lock can never both succeed. Lifecycle events
  through the EventPublisher port only.
- `sdkAdapter.js` — `toLockPort(lock, { owner, canRead, canWrite })`: forces owner id +
  namespace isolation + `lock:read`/`lock:write` capability enforcement; no internals leak.
- `index.js` — `createLockPlatform(deps)` composition root.

## Alternatives rejected

- **A raw mutex library / Redis Redlock** — rejected: couples to one technology; distributed
  coordination is out of scope. Providers are swappable behind the port.
- **Ambient/global lock registry** — rejected: breaks DI and determinism. State lives in the
  injected provider; time is injected.
- **Exposing the provider to extensions** — rejected: breaks isolation. Extensions get only
  the owner-scoped port.

## Consequences

- New files under `src/domain/lock/**` and `src/application/lock/**`, plus
  `tests/unit/lock.test.js` (+15 tests). Zero hot-path change; A/B byte-identical.
- Distributed consensus, fencing tokens across processes, and fair-queue acquisition are
  future work behind these ports.

## Rollback

Delete `src/domain/lock/`, `src/application/lock/`, and `tests/unit/lock.test.js`. Nothing
imports them at runtime, so removal is inert and the platform is unchanged.
