# Enterprise Bootstrap Runtime — Operations Guide (ADR-043)

This guide is for operators running the OnCall platform in production via the Bootstrap
Runtime. The runtime is the single supervised entry point above the Composition Root
(ADR-042).

## Starting the platform

```js
const { bootstrap } = require('./src/runtime');
const runtime = await bootstrap({ environment: 'production' });
await runtime.ready();
```

`bootstrap` will **refuse to start** an invalid platform: it runs full startup verification
first and throws `StartupVerificationError` (with the failing checks) before any kernel is
started. Treat that error as a hard abort — investigate the reported check, do not retry
blindly.

## Readiness vs liveness

- **Readiness** (`health().readiness.ready`) — the platform is started and every kernel
  reports healthy. Use this for load-balancer/ingress readiness probes; route traffic only
  when ready.
- **Liveness** (`health().liveness.live`) — the runtime process is responsive and not in a
  terminal `failed`/`stopped` state. Use this for liveness probes; a false value should
  trigger a restart of the process.

The supervisor moves `ready ⇄ degraded` automatically as kernel health changes, so a
degraded platform is visible in `health().runtime.state` without flapping the process.

## Health monitoring

```js
const h = await runtime.health();
h.status;                 // 'healthy' | 'degraded' | 'unhealthy'
h.runtime.state;          // supervisor state machine
h.kernels['gateway'];     // per-kernel health
h.startupDurationMs;      // how long bootstrap took
h.shutdownState;          // { shuttingDown, stopped }
```

Wire `health()` to your metrics/alerting. Alert on `status !== 'healthy'`, on
`runtime.state === 'degraded'` persisting, and on any entries in `runtime.failures`.

## Graceful shutdown

On `SIGTERM`/`SIGINT`, call `shutdown()` and exit when it resolves:

```js
process.on('SIGTERM', async () => {
  try {
    await runtime.shutdown({ timeoutMs: 25000 });
    process.exit(0);
  } catch (e) {
    // graceful path exceeded the timeout — force, then exit non-zero
    await runtime.shutdown({ force: true, timeoutMs: 5000 });
    process.exit(1);
  }
});
```

Graceful shutdown delegates to the Lifecycle Kernel, stopping kernels in reverse dependency
order, and verifies afterward that no components remain started. A forced shutdown returns
`{ mode: 'forced' }` and skips waiting on a stuck graceful path once the timeout elapses.

## Restart

```js
await runtime.restart();               // verify → shutdown → rebuild → start → verify
await runtime.restart({ force: true }); // proceed even if pre-restart verification fails
```

Restart rebuilds a completely fresh platform (independently verified) and swaps it in. Use
it for recovering from a degraded state or applying new injected providers/config. The
restart count is available in `health().runtime.restarts`.

## Failure handling

- `StartupVerificationError` — platform failed pre-start checks; the platform was **not**
  started. Inspect `err.details.failed`.
- `BootstrapError` — an unexpected failure during create/start; inspect `err.details.cause`.
- `ShutdownError` — shutdown exceeded the timeout (and was not forced) or failed
  verification.
- `RestartError` — restart could not complete; the supervisor is in `failed` state.

The supervisor records the last failures in `health().runtime.failures` for post-mortem.

## What the runtime does NOT do

It runs no business logic, defines no kernels, and modifies no kernel or ADR-042. All domain
behavior lives in the kernels; the runtime only bootstraps, supervises, and shuts them down.
