# ADR-039 — Enterprise Resource Management Kernel

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 15.10 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-022 (Lock), ADR-025 (Policy), ADR-026 (Audit), ADR-027 (Identity), ADR-038
(Multi-Tenancy) — integrated through their existing ports.

## Context

The platform needs one deterministic way to govern shared capacity: register resources,
allocate against them, enforce per-owner quotas, honor reservations, resolve contention by
priority, and account every unit — independent of any infrastructure quota mechanism. This
is the Resource Management Kernel. It is **not Kubernetes ResourceQuota**, **not Linux
cgroups**, **not Docker resource limits**, and **not a cloud autoscaler** — those are
infrastructure controls; this kernel is the deterministic control-plane governor other
kernels consume.

Resource logic must never be embedded in application services (each tracking its own free
list). Instead it is a Kernel Service behind a narrow port, so every service allocates the
same way and capacity is never over-committed.

To stay strictly additive, the kernel lives under `resources/` (new directories); no
existing kernel or application bounded context is touched.

## Decision

Add an additive Resource Management Kernel. Nothing in it is on a hot path, so the platform
runs byte-identically whether or not it is instantiated.

**Domain (pure):**

- `resource.js` — the Resource value object (resourceId, namespace, resourceType, owner,
  capacity, allocated, available, quota, reservation, priority, status, labels, metadata,
  version, `checksum`) with capacity math (`allocatable` = capacity − reservation,
  `availableAmount`, `canAllocate`, `applyAllocate`/`applyRelease`). The checksum covers the
  definition but NOT the volatile allocated/available/status/timestamps.
- `allocation.js` — the Allocation value object (allocationId, resourceId, owner, amount,
  priority, status active/released/preempted, checksum).
- `errors.js` — `ResourceError`, `ResourceValidationError`, `ResourceNotFoundError`,
  `QuotaExceededError`, `ResourceConflictError`, `IntegrityError`.
- `events.js` — the event catalog (ResourceRegistered, ResourceAllocated, ResourceReleased,
  QuotaExceeded, ResourceUpdated, ResourceVerified); producer `resources`.

**Application (ports & adapters):**

- `providerPort.js` — the persistence contract (putResource / getResource / listResources /
  removeResource / putAllocation / getAllocation / listAllocations / health) + declared
  extension points (PostgreSQL, Storage, Redis, MongoDB, cloud registry, custom). Providers
  persist definitions + allocation state; the engine owns all behavior.
- `providers/memoryProvider.js` — the implemented in-process resource + allocation store.
- `metrics.js` — registered resources + active allocations (gauges), released allocations,
  quota violations, allocation latency, resource utilization (gauge), provider failures,
  verification runs, uptime; Prometheus.
- `resourcesPort.js` — the abstraction contract (`assertResources`): registerResource,
  allocate, release, query, verify, health.
- `resourcesService.js` — the kernel: deterministic allocation, capacity tracking,
  reservation management, quota enforcement, priority-based allocation with preemption,
  conflict detection, lifecycle management, allocation history, verification, and resource
  accounting. Allocations against one resource are atomic via a serialization mutex, so
  capacity is **never over-committed**.
- `sdkAdapter.js` — `toResourcePort(resources, { owner, canRead, canAllocate })`: namespace
  isolation + owner-stamped allocations + `resource:read` / `resource:allocate` enforcement.
- `index.js` — `createResourcePlatform(deps)` composition root.

## Kernel integration

Per §5, the Resource Management Kernel integrates with other kernels **only through their
existing ports**: Multi-Tenancy (ADR-038) scopes resources/quotas per tenant; Policy
(ADR-025) and Identity (ADR-027) authorize allocation; the Lock Platform (ADR-022) can guard
distributed allocation; the Event Backbone (EventPublisher) carries lifecycle events;
Observability (ADR-033) consumes utilization; Audit (ADR-026) records events; Storage
(ADR-021) is the model behind a durable provider. It imports no implementation classes.

## Alternatives rejected

- **Kubernetes ResourceQuota / cgroups / Docker limits / autoscalers** — rejected: couples
  governance to infrastructure. Those remain deployment concerns; this kernel is the
  deterministic control plane.
- **Ad-hoc free lists per service** — rejected: risks over-commit and defeats uniform quota
  + audit.
- **Random/first-come contention** — rejected: contention is resolved deterministically by
  priority with preemption of strictly-lower-priority allocations.
- **Provider-side allocation** — rejected: allocation, quota, reservation, preemption, and
  accounting live in the engine so behavior is uniform regardless of provider.

## Consequences

- New files under `src/domain/resources/**` and `src/application/resources/**`, plus
  `tests/unit/resources.test.js` (+14 tests). Zero hot-path change; A/B byte-identical.
- Real stores (Postgres/Storage/Redis/Mongo/cloud), fair-share/weighted scheduling, and
  time-based leases are future work behind the provider port. The memory provider is
  single-process (the per-resource mutex prevents over-commit in-process).

## Rollback

Delete `src/domain/resources/`, `src/application/resources/`, and
`tests/unit/resources.test.js`. Nothing imports them at runtime, so removal is inert and
every prior kernel (ADR-016 … ADR-038) is unchanged. See `docs/RESOURCES-ROLLBACK-PLAN.md`.
