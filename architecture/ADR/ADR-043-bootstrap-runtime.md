# ADR-043 — Enterprise Bootstrap Runtime

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 16.2 · **Sits above:** ADR-042 (Composition Root). **Depends on:** ADR-040
(Lifecycle) for shutdown delegation, ADR-041 (Compatibility) + all kernels via ADR-042.

## Context

The Composition Root (ADR-042) can compose every Enterprise Kernel into a runtime and
expose `start/shutdown/health/verify/getKernel/listKernels/version`. What it does **not**
do is own the production bootstrap sequence: verifying the platform *before* starting it,
waiting until it is ready, supervising it while it runs, and coordinating graceful/forced
shutdown and restart. Doing that by hand at every entry point would duplicate operational
logic and risk starting an unverified platform.

This ADR introduces the **Enterprise Bootstrap Runtime** under `src/runtime/`. It is a thin
layer directly above ADR-042 that creates, validates, starts, supervises, and shuts down
the complete platform. It is explicitly **not a Kernel**, **not a framework**, and **not an
application layer**. It never modifies a kernel and never modifies ADR-042; it only
orchestrates them, delegating composition to ADR-042 and lifecycle to ADR-040.

The whole point is that production startup becomes:

```js
import { bootstrap } from './runtime';
const runtime = await bootstrap(config);
await runtime.ready();
```

## Decision

Add `src/runtime/` with seven files, all additive:

- **`errors.js`** — the runtime error model: `RuntimeError`, `StartupVerificationError`,
  `BootstrapError`, `ShutdownError`, `RestartError`, `RuntimeStateError`,
  `RuntimeVerificationError`. These describe bootstrap/supervision faults only; composition
  faults remain ADR-042's `PlatformError` family; kernel faults remain the kernels' own.
- **`runtimeContext.js`** — one immutable Runtime Context per bootstrapped instance:
  platform, configuration, environment, startup timestamp, version, supervisor, shutdown
  manager, health snapshot, bootstrap metadata. Frozen; the latest health snapshot lives in
  a small holder the supervisor updates.
- **`startupVerifier.js`** — runs **before** `platform.start()`. Delegates
  composition/graph/registration/ports/providers/compatibility to `platform.verify()`
  (ADR-042 §9) and adds two runtime preconditions — configuration loaded and event backbone
  operational. **Aborts immediately** (throws `StartupVerificationError`) on any failure.
- **`runtimeSupervisor.js`** — supervises platform lifecycle state, samples kernel health,
  records unexpected failures, and exposes readiness / shutdown / restart state through a
  small state machine (`created → verifying → starting → ready ⇄ degraded → shutting-down →
  stopped`, plus `restarting`/`failed`). Contains **no business logic**.
- **`shutdownManager.js`** — orchestrates shutdown by **delegating to the Lifecycle Kernel**
  (ADR-040) via `platform.shutdown()`. Adds runtime policy: graceful shutdown, forced
  shutdown, a shutdown timeout (cancellable timer), and shutdown verification (confirms the
  Lifecycle kernel reports zero started components).
- **`runtime.js`** — the Runtime object. Exposes ONLY the seven §2 methods: `ready()`,
  `health()`, `verify()`, `shutdown()`, `restart()`, `platform()`, `version()`.
- **`bootstrap.js`** — exposes ONLY `bootstrap(options)`: create → verify → start → wait
  until ready → return Runtime. The single `assemble()` path is reused by restart, so
  composition logic exists in exactly one place.
- **`index.js`** — the public entry point re-exporting `bootstrap` plus building blocks.

**Restart (§7)** performs verify → shutdown → rebuild platform → start → verify by calling
the same `assemble()` path bootstrap uses. It never duplicates composition logic; the
supervisor persists across restarts and counts them.

**Health (§8)** aggregates runtime state, platform health, lifecycle health, per-kernel
health, readiness, liveness, startup duration, and shutdown state.

**Verification (§9)** confirms bootstrap completed, platform verified, all kernels healthy,
runtime context valid, lifecycle operational, and compatibility operational.

## Alternatives rejected

- **Bootstrapping inline at each entry point** — rejected: duplicates verify/start/ready
  logic and risks starting an unverified platform.
- **Putting bootstrap logic inside ADR-042** — rejected: the Composition Root composes; it
  should not own operational supervision, timeouts, or restart policy. Separation keeps
  ADR-042 unchanged.
- **Re-implementing shutdown ordering** — rejected: ordering lives in the Lifecycle Kernel;
  the shutdown manager delegates to it and only adds timeout/force/verify policy.
- **A mutable global runtime singleton** — rejected: the runtime, supervisor, and context
  are per-bootstrap instances; two runtimes share no state.

## Consequences

- New files under `src/runtime/**` and `tests/unit/runtime.test.js` (+21 tests). Zero
  hot-path change; importing the module wires nothing until `bootstrap(...)` runs, so all
  ten application A/B harnesses stay byte-identical.
- Production startup is a two-line call. Restart rebuilds a fresh, independently verified
  platform. Shutdown is graceful by default with a forced fallback and post-shutdown
  verification.

## Rollback

Delete `src/runtime/` and `tests/unit/runtime.test.js`. Nothing else imports them, so
removal is inert and ADR-042 plus every kernel (ADR-016 … ADR-041) is unchanged. See
`docs/RUNTIME-ROLLBACK-PLAN.md`.
