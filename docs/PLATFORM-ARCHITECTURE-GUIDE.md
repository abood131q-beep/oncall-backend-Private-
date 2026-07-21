# Enterprise Platform Composition Root — Architecture Guide (ADR-042)

## Where it sits

```
Applications / Extensions (ADR-018 SDK)
        │  consume kernel public services
        ▼
Enterprise Platform Composition Root  ── src/platform/  (THIS LAYER)
        │  composes via DI, in dependency order
        ▼
Enterprise Kernels  ── ADR-016 … ADR-041  (independent, additive, port-bounded)
        │
        ▼
Domain (pure)  +  Providers (metadata/persistence adapters)
```

The composition root is a thin, non-kernel layer. It is the **only** place that knows
every kernel. Kernels below it never know each other; applications above it consume kernel
services but do not compose them.

## Responsibilities (and non-responsibilities)

It **does**: build one immutable context; register kernel descriptors; validate and order
the dependency graph; compose each kernel through its own `create*Platform` factory via
dependency injection; delegate start/shutdown to the Lifecycle Kernel; aggregate health;
run platform-wide verification.

It **does not**: implement domain logic, modify any kernel, touch any kernel public API,
bypass any kernel port, hold global/singleton state, or re-implement lifecycle ordering
(that is delegated to ADR-040).

## The seven modules

| Module               | Role                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `errors.js`          | Composition error model (registration/graph/resolution/verification).|
| `platformContext.js` | One immutable, frozen shared context + `scopeFor(needs)` slicing.    |
| `kernelRegistry.js`  | Per-platform registry: `register/resolve/list/verify`. No globals.   |
| `dependencyGraph.js` | Pure deterministic validation + topological startup/shutdown order.  |
| `platformHealth.js`  | Aggregates each kernel's `health()` into one verdict.                |
| `platformBuilder.js` | The `KERNELS` catalog + `createPlatform`; composes + delegates.      |
| `index.js`           | Public entry point.                                                  |

## Dependency injection model

Each kernel descriptor declares:

- **`needs`** — the context slices it receives (default `publisher`, `clock`, `logger`).
  Nothing else is visible to it.
- **`dependsOn`** — kernels it is ordered after (composition + lifecycle edges).
- **`ports`** — dependency kernels whose *public services* are injected as `deps.ports`
  (Gateway, Mesh). The kernel already expects this exact seam.
- **`inject`** — named cross-kernel deps injected as top-level factory args (Workflow ←
  `storage`, `lock`).
- **`serviceKey`** — the key on the factory's return object holding the kernel service.
- **`start` / `stop`** — optional hooks delegated to the Lifecycle Kernel (Config's
  `init()` is a start hook).

Because dependencies flow *in* (injected) and never *out* (imported), the graph is a DAG
and kernels stay independent.

## Two distinct orderings

1. **Composition (build-time)** — a kernel constructor that receives an injected port needs
   that port's service to already exist, so kernels are *instantiated* in topological
   order. This is inherent to constructor injection.
2. **Runtime lifecycle (start/stop)** — delegated entirely to the Lifecycle Kernel, which
   independently computes the same topological order from the components the composition
   root registers.

These are separate concerns; the composition root owns (1) and delegates (2). It does not
duplicate lifecycle logic.

## Determinism, immutability, safety

- The dependency graph uses a deterministic Kahn sort with a registration-index tiebreak,
  so ordering is reproducible.
- The context is `Object.freeze`d; kernels get frozen `scopeFor` subsets.
- The registry is closure-scoped per platform — two platforms share no state.
- Importing `src/platform` instantiates nothing; a runtime exists only after
  `createPlatform(...)`, preserving byte-identical application behavior.

## Failure modes

Duplicate registration → `DuplicateKernelError`; unknown dependency/port →
`MissingDependencyError`; cycle → `DependencyCycleError` (with the cycle); a failing
factory → `CompositionError`; failed platform verification → surfaced in `verify()` /
`PlatformVerificationError`. Kernel-internal faults remain the kernels' own typed errors.
