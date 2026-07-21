# Enterprise Host Runtime — Operations Guide (ADR-044)

This guide is for operators running multiple hosted units (gateway, workers, admin,
plugins) under one platform via the Host Runtime, which sits directly above the Bootstrap
Runtime (ADR-043).

## Starting a host

```js
const { bootstrap } = require('./src/runtime');
const { createHost } = require('./src/host');

const runtime = await bootstrap({ environment: 'production' });
const host = await createHost({ runtime });
await host.register(apiGatewayService);
await host.register(workerService);
await host.start();
```

Startup order is **Runtime → hosted services**: the host first confirms the Runtime is
ready (delegated to ADR-043), then starts services in dependency order. If any service
fails to start, the host transitions to `failed` and surfaces `ServiceLifecycleError` — the
failing service's id is in `err.details.service` and in `health().host.failures`.

## Readiness vs liveness

- **Readiness** (`health().readiness.ready`) — Runtime healthy AND every started service
  healthy. Use for ingress/load-balancer readiness probes.
- **Liveness** (`health().liveness.live`) — the host is not in a terminal `failed`/`stopped`
  state. Use for liveness probes.

The supervisor moves `ready ⇄ degraded` automatically as service/runtime health changes, so
a single unhealthy service degrades the host without flapping the process.

## Health monitoring

```js
const h = await host.health();
h.status;                 // 'healthy' | 'degraded' | 'unhealthy'
h.services['worker'];     // per-service health
h.unhealthyServices;      // ids currently unhealthy
h.host.restarts;          // restart count
h.startupDurationMs;      // last startup duration
```

Alert on `status !== 'healthy'`, on non-empty `unhealthyServices`, and on entries in
`host.failures`.

## Graceful shutdown

On `SIGTERM`/`SIGINT`, stop the host; services stop in reverse dependency order and the
Runtime stops last:

```js
process.on('SIGTERM', async () => {
  const r = await host.stop({ timeoutMs: 25000 });
  process.exit(r.ok ? 0 : 1);
});
```

`stop()` returns `{ ok, stopped: [...ids reverse order...], serviceErrors, runtime }`. A
service that throws during stop is recorded but does not block the rest (graceful); the
Runtime shutdown still runs last and carries ADR-043's timeout/force policy via `opts`.

## Restart

```js
await host.restart();               // stop services → runtime.restart() → start services
```

Restart rebuilds the platform (fresh, re-verified) and restarts all hosted services in
order. Use it to recover from a degraded host or to apply new injected providers/config.
`health().host.restarts` tracks the count.

## Managing services

```js
await host.register(newService);    // dynamic add (starts now if deps already started)
await host.unregister('worker');    // stop (if running) + remove
host.listServices();                // descriptors: id, name, version, dependsOn, needs
```

Dynamic registration after start requires the new service's declared dependencies to be
started already, else `HostStateError`.

## Failure handling

- `ServiceContractError` — a registered object doesn't satisfy the nine-method contract.
- `DuplicateServiceError` — two services share an id.
- `ServiceDependencyError` — missing dependency or a cycle in the service graph.
- `ServiceLifecycleError` — a service failed to start.
- `HostVerificationError` — `verify()` (via `assertVerified`) found a failing check.

The supervisor records recent failures in `health().host.failures` for post-mortem.

## What the host does NOT do

It runs no business logic, defines no kernels, and modifies no kernel, ADR-042, or ADR-043.
All domain behavior lives in the kernels and in the hosted services themselves; the host
only registers, orders, supervises, and shuts them down.
