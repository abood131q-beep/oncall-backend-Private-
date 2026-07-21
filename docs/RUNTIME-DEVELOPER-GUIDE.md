# Enterprise Bootstrap Runtime — Developer Guide (ADR-043)

The Bootstrap Runtime is the thin production layer directly above the Composition Root
(ADR-042). It creates, verifies, starts, supervises, and shuts down the complete Enterprise
Platform. It is **not a kernel, not a framework, not an application layer**. It lives under
`src/runtime/`, strictly additive.

## 1. Production startup (the whole thing)

```js
const { bootstrap } = require('../../src/runtime');

const runtime = await bootstrap(config);
await runtime.ready();
```

`bootstrap(options)` performs: create platform → verify platform (aborts on failure) →
start platform → wait until ready → return a Runtime. If startup verification fails it
throws `StartupVerificationError` and never starts the platform.

## 2. The runtime API (exactly seven methods)

```js
await runtime.ready();       // resolves once ready; throws RuntimeStateError otherwise
await runtime.health();      // aggregated runtime + platform + lifecycle + per-kernel health
await runtime.verify();      // six runtime-level checks (see §9)
await runtime.shutdown();    // graceful shutdown, delegated to the Lifecycle Kernel
await runtime.restart();     // verify → shutdown → rebuild → start → verify
runtime.platform();          // the composed Platform (ADR-042)
runtime.version();           // platform/runtime version string
```

## 3. Options

`bootstrap(options)` forwards composition options to `createPlatform` (ADR-042). Common
options:

```js
await bootstrap({
  environment: 'production',        // default: NODE_ENV || 'development'
  version: '16.2.0',
  // publisher: myEventBackbone,    // default: in-process Event Backbone (ADR-016)
  // config: { 'http.port': 3000 },
  // kernelOptions: { audit: { provider: pgProvider } },  // per-kernel real providers
  shutdownTimeoutMs: 30000,         // shutdown manager timeout
});
```

To scope composition options separately from runtime options, pass `options.platform`;
otherwise the whole `options` object is used as the platform options.

## 4. Health

```js
const h = await runtime.health();
// {
//   status, runtime: { state, ready, ... }, platform: { status, overall },
//   lifecycle: { started, ... }, kernels: { <name>: {...} },
//   readiness: { ready, composed }, liveness: { live },
//   startupDurationMs, shutdownState: { shuttingDown, stopped },
//   uptimeMs, environment, version
// }
```

## 5. Verification

```js
const v = await runtime.verify();
// { ok, checks: { bootstrapCompleted, platformVerified, allKernelsHealthy,
//                 runtimeContextValid, lifecycleOperational, compatibilityOperational } }
```

## 6. Shutdown (graceful / forced / timeout / verify)

```js
await runtime.shutdown();                          // graceful, verified
await runtime.shutdown({ timeoutMs: 5000 });       // bounded wait
await runtime.shutdown({ force: true, timeoutMs: 5000 }); // forced on timeout
```

Shutdown is delegated to the Lifecycle Kernel (ADR-040), which stops kernels in reverse
dependency order. The shutdown manager adds timeout + force policy and verifies that no
lifecycle components remain started.

## 7. Restart

```js
await runtime.restart();
```

Restart runs verify → shutdown → **rebuild a fresh platform** → start → verify, reusing the
same `assemble()` path bootstrap uses (no duplicated composition). The supervisor persists
across restarts and counts them; `runtime.platform()` returns the new platform afterward.

## 8. Runtime context

```js
const ctx = runtime.context(); // frozen
// { platform, configuration, environment, startedAt, version, supervisor,
//   shutdownManager, bootstrapMetadata, healthSnapshot(), uptimeMs() }
```

## Determinism & independence

- **Thin & delegating** — composition is ADR-042's job; lifecycle ordering is ADR-040's.
  The runtime only orchestrates and supervises.
- **Immutable context** — the runtime context is frozen; only the small health-snapshot
  holder is updated by the supervisor.
- **No globals** — every bootstrap yields an independent runtime, supervisor, and context.
- **Additive** — importing `src/runtime` instantiates nothing; a runtime exists only after
  `bootstrap(...)`.
