# ADR-040 — Enterprise Lifecycle Management Kernel

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 15.11 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-020 (Scheduler), ADR-022 (Lock), ADR-025 (Policy), ADR-026 (Audit), ADR-033
(Observability) — integrated through their existing ports.

## Context

The platform needs one deterministic way to bring components up and down: register them,
validate their dependency graph, initialize and start them in the right order, shut them
down gracefully in reverse, and support suspend/resume and restart — independent of any
process supervisor. This is the Lifecycle Management Kernel. It is **not systemd**, **not
Kubernetes Operators**, **not Docker Compose**, and **not PM2** — those are process/OS
supervisors; this kernel is the deterministic control-plane orchestrator other kernels
consume.

Lifecycle logic must never be embedded in application services (each wiring its own boot
order). Instead it is a Kernel Service behind a narrow port, so every component is sequenced
the same way and dependency ordering is computed in one place.

To stay strictly additive, the kernel lives under `lifecycle/` (new directories); no
existing kernel or application bounded context is touched.

## Decision

Add an additive Lifecycle Management Kernel. Nothing in it is on a hot path, so the platform
runs byte-identically whether or not it is instantiated.

**Domain (pure):**

- `component.js` — the Component value object (componentId, namespace, componentType,
  lifecycleState, dependencies, startupPriority, shutdownPriority, initializationPolicy,
  restartPolicy, healthStatus, metadata, version, `checksum`) with validated `transition`.
  The checksum covers the definition but NOT the volatile lifecycleState/healthStatus/
  timestamps.
- `states.js` — the state machine (registered/initialized/started/suspended/stopped/failed)
  + `validTransition` predicate.
- `graph.js` — deterministic dependency `topoSort` (deps first, ties by startupPriority desc
  then id) + `shutdownOrder` (reverse), with cycle + missing-dependency detection.
- `errors.js` — `LifecycleError`, `LifecycleValidationError`, `ComponentNotFoundError`,
  `DependencyError`, `TransitionError`, `IntegrityError`.
- `events.js` — the event catalog (ComponentRegistered, ComponentInitialized,
  ComponentStarted, ComponentStopped, ComponentRestarted, LifecycleStateChanged,
  LifecycleVerified); producer `lifecycle`.

**Application (ports & adapters):**

- `providerPort.js` — the persistence contract (putComponent / getComponent /
  listComponents / removeComponent / health) + declared extension points (PostgreSQL,
  Storage, Redis, MongoDB, cloud registry, custom). Providers persist metadata; the engine
  owns all orchestration.
- `providers/memoryProvider.js` — the implemented in-process component store.
- `metrics.js` — registered + started components (gauges), initialized/stopped, restart
  operations, failed transitions, startup + shutdown latency, provider failures, uptime;
  Prometheus.
- `lifecyclePort.js` — the abstraction contract (`assertLifecycle`): register, initialize,
  start, stop, restart, status, verify, health.
- `lifecycleService.js` — the kernel: deterministic startup ordering, dependency-graph
  validation, initialization orchestration, graceful shutdown, restart coordination,
  suspend/resume, state-transition validation, lifecycle history, verification, and
  health-aware orchestration (a component starts only once its dependencies are started).
  Component hooks (initialize/start/stop) are held in-process (never persisted). Orchestration
  is atomic per namespace via a serialization mutex.
- `sdkAdapter.js` — `toLifecyclePort(lifecycle, { owner, canRead, canManage })`: namespace
  isolation + `lifecycle:read` / `lifecycle:manage` enforcement (no registration).
- `index.js` — `createLifecyclePlatform(deps)` composition root.

## Kernel integration

Per §5, the Lifecycle Management Kernel integrates with other kernels **only through their
existing ports**: the Scheduler (ADR-020) can trigger orchestration; the Lock Platform
(ADR-022) can guard distributed startup; Policy (ADR-025) + Identity (ADR-027) authorize
management; the Event Backbone (EventPublisher) carries lifecycle events; Observability
(ADR-033) consumes health/latency; Audit (ADR-026) records events. It imports no
implementation classes — components supply plain hook functions.

## Alternatives rejected

- **systemd / K8s Operators / Docker Compose / PM2** — rejected: couples orchestration to a
  supervisor. Those remain deployment concerns; this kernel is the deterministic control
  plane.
- **Ad-hoc boot order per service** — rejected: duplicates ordering logic and risks
  boot-order bugs; ordering is computed once from the dependency graph.
- **Random/first-registered ordering** — rejected: startup is a deterministic topological
  sort with a priority tiebreak; shutdown is its exact reverse.
- **Provider-side orchestration** — rejected: ordering, transitions, and validation live in
  the engine so behavior is uniform regardless of provider.

## Consequences

- New files under `src/domain/lifecycle/**` and `src/application/lifecycle/**`, plus
  `tests/unit/lifecycle.test.js` (+17 tests). Zero hot-path change; A/B byte-identical.
- Real stores (Postgres/Storage/Redis/Mongo/cloud), parallel same-tier startup, and
  readiness/liveness probing are future work behind the provider port. The memory provider is
  single-process.

## Rollback

Delete `src/domain/lifecycle/`, `src/application/lifecycle/`, and
`tests/unit/lifecycle.test.js`. Nothing imports them at runtime, so removal is inert and
every prior kernel (ADR-016 … ADR-039) is unchanged. See `docs/LIFECYCLE-ROLLBACK-PLAN.md`.
