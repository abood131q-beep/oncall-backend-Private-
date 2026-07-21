# ADR-044 — Enterprise Host Runtime

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 16.3 · **Sits above:** ADR-043 (Bootstrap Runtime). **Uses:** ADR-042's
dependency graph for service ordering; delegates platform lifecycle to ADR-043/ADR-040.

## Context

The Bootstrap Runtime (ADR-043) brings up one complete Enterprise Platform and supervises
it. But a real deployment often runs several cooperating units against that one platform —
an API gateway process, background workers, an admin surface, plugins — each with its own
start/stop/health/verify lifecycle. Without a host layer, each unit would re-implement
registration, ordering, health aggregation, and shutdown, and nothing would guarantee they
stay isolated from one another.

This ADR introduces the **Enterprise Host Runtime** under `src/host/`. It hosts multiple
services, applications, workers, gateways, and plugins under ONE Runtime while preserving
complete architectural isolation. It is explicitly **not a Kernel**, **not an application
framework**, and **not a microservice framework**. It never modifies any kernel, ADR-042,
or ADR-043; it only orchestrates — delegating platform lifecycle to the Runtime and
ordering hosted services with the same deterministic graph the Composition Root uses.

Production hosting becomes:

```js
import { bootstrap } from './runtime';
import { createHost } from './host';
const runtime = await bootstrap(config);
const host = await createHost({ runtime });
await host.register(apiGatewayService);
await host.register(workerService);
await host.register(adminService);
await host.start();
```

## Decision

Add `src/host/` with eight files, all additive:

- **`errors.js`** — the host error model: `HostError`, `HostStateError`,
  `ServiceContractError`, `DuplicateServiceError`, `ServiceNotFoundError`,
  `ServiceDependencyError`, `ServiceLifecycleError`, `HostVerificationError`.
- **`hostContext.js`** — one immutable Host Context (runtime, platform, configuration,
  logger, metrics, environment, version, shared services). `scopeFor(needs)` returns a
  frozen subset, so **each hosted service receives only the context it declares** — it
  cannot reach the runtime, platform, or a sibling unless it declares that slice.
- **`hostRegistry.js`** — the §2 **hosted service contract** (`id/name/version/
  dependencies/start/stop/health/verify/metadata`) with `assertServiceContract`, and the
  per-host registry (`register/unregister/resolve/list/verify`) detecting duplicate ids,
  missing services, and invalid contracts. No service accesses another directly; the only
  sibling reference a service may name is a dependency id.
- **`hostSupervisor.js`** — monitors runtime state, per-service state, startup/shutdown
  failures, restart count, and health degradation via a state machine (`created → starting
  → ready ⇄ degraded → shutting-down → stopped`, plus `restarting`/`failed`). No business
  logic.
- **`hostLifecycle.js`** — orchestrates ordering: **startup = Runtime → hosted services**
  (dependency order); **shutdown = hosted services (reverse) → Runtime**. Platform
  lifecycle is delegated to ADR-043 (`runtime.ready()` / `runtime.shutdown()`); service
  ordering reuses ADR-042's `buildDependencyGraph` (no duplicated graph logic).
- **`host.js`** — the Host object: `register`, `unregister`, `start`, `stop`, `restart`,
  `health`, `verify`, `listServices`, `getService`, `runtime`, `context`, `version`.
  Restart rebuilds the platform via `runtime.restart()` then re-derives the host context +
  lifecycle from the fresh platform.
- **`hostBuilder.js`** — exposes ONLY `createHost(options)`; validates the runtime and
  wires the context, registry, supervisor, and lifecycle.
- **`index.js`** — the public entry point.

**Health (§8)** aggregates host health, runtime health, per-service health, overall
readiness, overall liveness, startup duration, and shutdown state. **Verification (§9)**
confirms runtime healthy, all services verified, dependency graph valid, startup order
valid, shutdown order valid, and contracts valid.

## Alternatives rejected

- **Letting each unit bootstrap its own runtime** — rejected: wasteful and breaks the
  single-platform guarantee; the host manages one Runtime for all hosted units.
- **Services referencing each other directly** — rejected: violates isolation. Services
  declare dependency ids for *ordering* only and receive just the context slices they
  declare; they never get sibling handles.
- **A bespoke host dependency graph** — rejected: ADR-042 already has a deterministic,
  tested graph; the host reuses it (adapting service ids to graph nodes).
- **Re-implementing platform/kernel shutdown** — rejected: the host delegates platform
  lifecycle to ADR-043, which delegates kernel ordering to ADR-040.

## Consequences

- New files under `src/host/**` and `tests/unit/host.test.js` (+21 tests). Zero hot-path
  change; importing the module wires nothing until `createHost(...)` runs, so all ten
  application A/B harnesses stay byte-identical.
- Services may be registered before start, or dynamically after start (started immediately
  once their declared dependencies are already started). Restart rebuilds the platform and
  restarts all hosted services in order.

## Rollback

Delete `src/host/` and `tests/unit/host.test.js`. Nothing else imports them, so removal is
inert and ADR-043, ADR-042, and every kernel (ADR-016 … ADR-041) are unchanged. See
`docs/HOST-ROLLBACK-PLAN.md`.
