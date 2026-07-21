# ADR-042 — Enterprise Platform Composition Root

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 16.1 · **Composes:** ADR-016 … ADR-041 (every Enterprise Kernel).

## Context

The platform now has 26 Enterprise Kernels (ADR-016 … ADR-041), each an independent,
additive Kernel Service behind a narrow port. Until now nothing assembled them into one
runtime: each was instantiated ad hoc by tests or harnesses. We need a single,
deterministic, production-ready way to compose all kernels — while **preserving complete
kernel independence**. No kernel may import, instantiate, or even know another kernel.

This ADR introduces the **Enterprise Platform Composition Root** under `src/platform/`.
It is explicitly **not a Kernel** and **not an application service**. It is the one and
only layer permitted to know every kernel, and its sole job is composition: wire each
kernel through its own `create*Platform(...)` composition root via dependency injection,
in a deterministic dependency order, and expose one small runtime API.

The composition root never modifies a kernel, never touches a kernel's public API, and
never bypasses a kernel port. Cross-kernel needs (e.g. the API Gateway consulting Identity,
Policy, Rate Limiting, Feature Flags, and Discovery) are satisfied by **injecting the
dependency kernel's public service** as the consumer kernel's `ports` — exactly the seam
each kernel already exposes. Kernels remain oblivious to one another.

## Decision

Add `src/platform/` with seven files, all additive:

- **`errors.js`** — the composition error model: `PlatformError`,
  `PlatformValidationError`, `DuplicateKernelError`, `MissingDependencyError`,
  `DependencyCycleError`, `KernelResolutionError`, `CompositionError`,
  `PlatformVerificationError`. These describe composition faults only; kernel-internal
  faults surface as the kernels' own typed errors.
- **`platformContext.js`** — one immutable, frozen shared context created once and handed
  to kernels in need-only slices: `clock`, `logger`, `metrics`, `config` (a read-only
  view), `publisher` (the Event Backbone, ADR-016), `mutex` (deterministic per-key async
  mutex), `version`, `environment`, `healthProvider`, `sharedServices`. `scopeFor(needs)`
  returns a frozen subset so **every kernel receives ONLY what it needs**.
- **`kernelRegistry.js`** — a per-platform registry (closure-scoped; **no globals, no
  singleton state**): `register()`, `resolve()`, `list()`, `verify()`. It stores kernel
  *descriptors* (data), never kernel internals. Registration order is the deterministic
  tiebreak for topological ordering.
- **`dependencyGraph.js`** — pure, deterministic. Validates missing dependencies,
  duplicate registrations, and circular dependencies (reporting the offending cycle), then
  produces a deterministic Kahn topological **startup** order (dependencies first, ties by
  registration index) and its exact reverse as the **shutdown** order. Both `dependsOn`
  and `ports` edges constrain ordering.
- **`platformHealth.js`** — aggregates health by calling each kernel's own `health()` port
  (defensively), producing overall status, per-kernel status, startup readiness, shutdown
  readiness, and verification state.
- **`platformBuilder.js`** — the one layer that knows every kernel. It holds the `KERNELS`
  catalog (a data table mapping each kernel to its `create*Platform` factory, service key,
  dependencies, injected ports, and context needs), composes them in dependency order via
  DI, and delegates start/shutdown to the Lifecycle Kernel (ADR-040).
- **`index.js`** — the public entry point exposing `createPlatform(options)` plus the
  building blocks for testing.

**Platform API (exactly seven methods):** `start()`, `shutdown()`, `health()`,
`verify()`, `getKernel(name)`, `listKernels()`, `version()`.

**Lifecycle integration (§7):** startup and shutdown are **delegated** to the Lifecycle
Kernel — the composition root never re-implements lifecycle logic. Each composed kernel is
registered as a lifecycle *component* whose dependencies are its composition edges; the
config kernel's `init()` is wired as its lifecycle **start hook**. `start()` calls
`lifecycle.start()` (deterministic dependency-ordered startup); `shutdown()` calls
`lifecycle.stop()` (reverse-order graceful shutdown).

**Verification (§9):** `verify()` confirms all kernels registered, the dependency graph is
valid, there are no cycles, all required ports were injected, all providers are healthy,
and compatibility checks pass (delegated to the Compatibility Kernel, ADR-041).

## Composition order

The deterministic startup order produced by the graph:

```
event-backbone → config → storage → lock → identity → policy → features → messaging →
workflow → audit → scheduler → secrets → notifications → ratelimit → jobs → observability →
discovery → gateway → resilience → mesh → tenancy → resources → lifecycle → compatibility →
extensions
```

The Event Backbone (ADR-016) is composed first as the shared `publisher`. The Extension
SDK (ADR-018) is a *library* consumed by the Extension Platform (ADR-017), not a runtime
component, so it is not registered as a composed kernel. Every other kernel (ADR-019 …
ADR-041, plus ADR-017) is composed exactly once.

## Alternatives rejected

- **A "god" kernel that owns the others** — rejected: it would couple kernels and violate
  their independence. Composition is a separate, non-kernel layer.
- **Each kernel instantiating its dependencies** — rejected: kernels would import one
  another. Dependencies are injected by the composition root only.
- **Service locator / global singletons** — rejected: hidden coupling and shared mutable
  state. The registry and context are per-platform, frozen, and closure-scoped.
- **Re-implementing startup/shutdown ordering here** — rejected: that logic already lives
  in the Lifecycle Kernel; the composition root delegates to it. (The build-time
  composition graph is a distinct, instantiation-time concern — a kernel constructor that
  receives an injected port needs that port to exist first.)

## Consequences

- New files under `src/platform/**` and `tests/unit/platform.test.js` (+24 tests). Zero
  hot-path change; importing the module wires nothing until `createPlatform(...)` runs, so
  all ten application A/B harnesses stay byte-identical.
- Real providers (Postgres/Storage/Redis/…) are injected per kernel through
  `options.kernelOptions`; the defaults are the kernels' in-process providers.
- `options.only` composes a subset plus its transitive dependencies — useful for tests and
  partial deployments.

## Rollback

Delete `src/platform/` and `tests/unit/platform.test.js`. Nothing else imports them, so
removal is inert and every kernel (ADR-016 … ADR-041) is unchanged. See
`docs/PLATFORM-ROLLBACK-PLAN.md`.
