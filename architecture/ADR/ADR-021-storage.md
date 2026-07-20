# ADR-021 — Enterprise Storage Platform

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-20
**Phase:** 14.3.4 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration Platform), ADR-020 (Scheduler)

## Context

Platform Services and Extensions need persistence without binding to a specific database or
an ORM. This is the Storage Kernel: one abstraction over every persistence technology,
additive, in-process by default, deterministic, and reachable only through a Port. No
consumer may know which provider is active, and no business logic lives here.

## Decision

Add a self-contained, additive Storage Platform. Nothing in it is imported by a hot path, so
the platform runs byte-identically whether or not storage is instantiated.

**Domain (pure):**

- `record.js` — the StorageRecord value object: documents / key-value / binary via
  `value` + `contentType`, metadata, monotonic `version` (optimistic concurrency), TTL,
  namespace, collection; `bumpVersion`, `isExpired`, `toModel`.
- `query.js` — a small provider-agnostic filter (eq/ne/gt/gte/lt/lte/in/contains/exists) +
  sort + pagination over already-loaded records. Deterministic. **Not SQL, not an ORM.**
- `errors.js` — `StorageError`, `NotFoundError`, `ConcurrencyError`, `TransactionError`,
  `ValidationError`.
- `events.js` — self-contained storage event catalog (StorageCreated/Updated/Deleted,
  TransactionCommitted/RolledBack, StorageProviderChanged); producer `storage`.

**Application (ports & adapters):**

- `providerPort.js` — the low-level `StorageProvider` contract (`read/write/remove/has/scan/
  writeBatch/health`) + declared extension points (SQLite, PostgreSQL, MySQL, MongoDB, Redis,
  S3, Azure Blob, Google Cloud Storage). Providers are dumb record stores — no versioning,
  no events, no business rules.
- `providers/{memory,file}.js` — the two implemented adapters (file I/O injected; binary
  base64-encoded on disk).
- `cache.js` — per-key read cache with write-through, version tracking, and invalidation.
- `metrics.js` — reads/writes/updates/deletes/transactions, latency, cache hit/miss;
  Prometheus.
- `storageService.js` — the kernel: `get/put/update/delete/exists/list/query/transaction/
  batch/health`; namespaces + collections; optimistic locking; TTL; **atomic transactions
  with rollback and a nested-transaction guard**; writes serialized through an internal
  mutex so read-modify-write is atomic; lifecycle events through the EventPublisher port only.
- `sdkAdapter.js` — `toStoragePort(storage, { owner, canRead, canWrite })`: namespace
  isolation + ownership + capability enforcement; no provider internals leak.
- `index.js` — `createStoragePlatform(deps)` composition root.

## Alternatives rejected

- **An ORM / query builder** — rejected: explicitly out of scope; the kernel abstracts
  persistence, it does not model relations or generate SQL.
- **Coupling to a specific database** — rejected: providers are swappable behind the port;
  business logic never knows the active one.
- **Exposing the provider to extensions** — rejected: breaks isolation. Extensions get only
  the namespace-scoped port.

## Consequences

- New files under `src/domain/storage/**` and `src/application/storage/**`, plus
  `tests/unit/storage.test.js` (+17 tests). Zero hot-path change; A/B byte-identical.
- Durable providers (SQLite/Postgres/etc.), cross-process transactions, and secondary
  indexes are future work behind these ports.

## Rollback

Delete `src/domain/storage/`, `src/application/storage/`, and `tests/unit/storage.test.js`.
Nothing imports them at runtime, so removal is inert and the platform is unchanged.
