# Enterprise Platform Composition Root — Developer Guide (ADR-042)

The Composition Root assembles every Enterprise Kernel (ADR-016 … ADR-041) into one
production-ready runtime. It is **not a kernel** and **not an application service** — it is
the single layer that knows every kernel and wires them through dependency injection,
without modifying any kernel or bypassing any port. It lives under `src/platform/`,
strictly additive.

## 1. Create a platform

```js
const { createPlatform } = require('../../src/platform');

const platform = createPlatform({
  environment: 'production',      // default: NODE_ENV || 'development'
  version: '16.1.0',
  // publisher: myEventBackbone,  // default: in-process Event Backbone (ADR-016)
  // config: { 'http.port': 3000 },
  // kernelOptions: { audit: { provider: myPgProvider } },  // per-kernel extra deps
  // only: ['gateway'],           // compose a subset + its transitive dependencies
});
```

`createPlatform` composes every kernel synchronously in deterministic dependency order.
Nothing is started yet.

## 2. The platform API (exactly seven methods)

```js
await platform.start();            // dependency-ordered startup (delegated to Lifecycle)
await platform.shutdown();         // reverse-order graceful shutdown (delegated)
await platform.health();           // aggregated per-kernel health + readiness
await platform.verify();           // graph + ports + providers + compatibility checks
platform.getKernel('gateway');     // a composed kernel's public service (or null)
platform.listKernels();            // [{ name, adr }] in startup order
platform.version();                // platform version string
```

## 3. Use a composed kernel

```js
await platform.start();
const compatibility = platform.getKernel('compatibility');
await compatibility.registerContract({ contractId: 'billing', component: 'billing', version: '2.0.0' });

const gateway = platform.getKernel('gateway');
await gateway.registerRoute({ method: 'GET', path: '/trips/:id', targetService: 'trips' });
```

Each kernel is returned as its own public service — the exact object its
`create*Platform(...)` composition root exposes. The platform never wraps or alters it.

## 4. Startup & shutdown are delegated to the Lifecycle Kernel

`start()` registers every composed kernel as a Lifecycle component (dependencies = its
composition edges) and calls `lifecycle.start()`, which orders them by a topological sort.
`shutdown()` calls `lifecycle.stop()`, which runs the exact reverse order. The composition
root never re-implements ordering — it delegates to ADR-040.

The config kernel's `init()` (its first-snapshot build) is wired as a Lifecycle **start
hook**, so configuration is loaded during `start()`, not at composition time.

## 5. Health & verification

```js
const h = await platform.health();
// { status, overall, healthyKernels, totalKernels, kernels: { <name>: {...} },
//   startupReadiness, shutdownReadiness, verification, environment, version }

const v = await platform.verify();
// { ok, checks: { allRegistered, dependencyGraph, noCycles, portsInjected,
//                 providersHealthy, compatibility } }
```

`verify()` confirms all kernels registered, the graph is valid, there are no cycles, all
injected ports are present, all providers are healthy, and compatibility checks pass
(delegated to the Compatibility Kernel).

## 6. Injecting real providers

Every kernel keeps its own provider seam. Inject production providers per kernel via
`kernelOptions`:

```js
createPlatform({
  kernelOptions: {
    audit: { provider: createPostgresAuditProvider(pool) },
    storage: { provider: createS3StorageProvider(client) },
  },
});
```

## 7. Determinism & independence

- **Deterministic** — the same options always yield the same startup/shutdown order and
  the same composed structure (proven by the A/B tests).
- **Independent** — no kernel imports another. Cross-kernel needs (Gateway → Identity/
  Policy/RateLimit/Features/Discovery; Mesh → Identity/Policy/Resilience/RateLimit/
  Discovery; Workflow → Storage/Lock) are satisfied by injecting the dependency kernel's
  public service.
- **Immutable context** — the shared context is frozen; `scopeFor(needs)` hands each
  kernel only the slices it declared.
- **No globals** — the registry and context are per-platform; two platforms share no
  state.

## Out of scope

The composition root adds no new kernel behavior. It composes existing kernels; all
domain behavior remains in the kernels themselves.
