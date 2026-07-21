# Enterprise Host Runtime — Developer Guide (ADR-044)

The Host Runtime hosts multiple services, applications, workers, gateways, and plugins
under ONE Bootstrap Runtime (ADR-043) while keeping them fully isolated. It is **not a
kernel, not an application framework, not a microservice framework**. It lives under
`src/host/`, strictly additive.

## 1. Production hosting (the whole thing)

```js
const { bootstrap } = require('../../src/runtime');
const { createHost } = require('../../src/host');

const runtime = await bootstrap(config);
const host = await createHost({ runtime });

await host.register(apiGatewayService);
await host.register(workerService);
await host.register(adminService);

await host.start();
```

`createHost({ runtime })` requires an already-bootstrapped Runtime. It manages that one
runtime plus any number of hosted services.

## 2. The hosted service contract (§2)

A hosted service is any object exposing exactly these nine methods:

```js
const apiGatewayService = {
  id: () => 'api-gateway',            // unique, non-empty string
  name: () => 'API Gateway',
  version: () => '1.0.0',
  dependencies: () => ['storage-svc'],// ids of services that must start first
  metadata: () => ({ needs: ['logger', 'configuration'] }), // declared context slices
  start: async (ctx) => { /* ctx has ONLY the declared slices */ },
  stop: async () => { /* graceful stop */ },
  health: async () => ({ ok: true }),
  verify: async () => ({ ok: true }),
};
```

Isolation is enforced: a service never receives a handle to a sibling service. It names
dependency ids only for **ordering**, and it receives only the context slices listed in
`metadata().needs`.

## 3. Host API

```js
await host.register(service);      // add a service (before or after start)
await host.unregister('id');       // stop (if running) + remove
await host.start();                // Runtime → services (dependency order)
await host.stop();                 // services (reverse) → Runtime
await host.restart();              // stop services → runtime.restart() → start services
await host.health();               // aggregated host + runtime + per-service health
await host.verify();               // six host-level checks (see §9)
host.listServices();               // service descriptors
host.getService('id');             // a service (operator API)
host.runtime();                    // the underlying Runtime
host.context();                    // the immutable host context
host.version();                    // version string
```

## 4. Dependency ordering

Hosted services are started in a deterministic topological order (dependencies first) and
stopped in the exact reverse. The host reuses the Composition Root's dependency graph
(ADR-042), so ordering is stable and reproducible. Missing dependencies and cycles are
rejected at start with `ServiceDependencyError`.

## 5. Context injection (declare what you need)

```js
metadata: () => ({ needs: ['configuration', 'logger'] })
// start(ctx) receives ONLY { configuration, logger } — nothing else.
```

Available slices: `runtime`, `platform`, `configuration`, `logger`, `metrics`,
`environment`, `version`, `sharedServices`. Declaring an unknown slice throws.

## 6. Health & verification

```js
const h = await host.health();
// { status, host, runtime, services: { <id>: {ok} }, readiness, liveness,
//   startupDurationMs, shutdownState, unhealthyServices, environment, version }

const v = await host.verify();
// { ok, checks: { runtimeHealthy, allServicesVerified, dependencyGraphValid,
//                 startupOrderValid, shutdownOrderValid, contractsValid } }
```

## 7. Dynamic registration

After `start()`, `register(service)` starts the new service immediately — but only if all
its declared dependencies are already started (otherwise `HostStateError`).

## 8. Restart

`restart()` stops hosted services (reverse order), calls `runtime.restart()` (which
rebuilds and re-verifies the platform, ADR-043), re-derives the host context from the fresh
platform, and restarts all services in order. The supervisor counts restarts.

## Determinism & isolation

- **Thin & delegating** — platform lifecycle is the Runtime's job (ADR-043 → ADR-040);
  service ordering reuses ADR-042's graph.
- **Isolated** — services never see each other; each gets only its declared context slices.
- **Immutable context** — the host context is frozen; `scopeFor` hands out frozen subsets.
- **No globals** — every host has its own registry, supervisor, and context.
- **Additive** — importing `src/host` instantiates nothing; a host exists only after
  `createHost(...)`.
