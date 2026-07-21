# Enterprise Lifecycle Management Kernel — Developer Guide (ADR-040)

The Lifecycle Management Kernel is the platform's unified abstraction for deterministic
component registration, initialization, startup sequencing, graceful shutdown, suspension,
resumption, and lifecycle governance. It is **not systemd / Kubernetes Operators / Docker
Compose / PM2** — those are process supervisors. It lives under `lifecycle/`, additive to
every existing kernel.

## 1. Compose

```js
const { createLifecyclePlatform } = require('../../src/application/lifecycle');
const lk = createLifecyclePlatform({ publisher }); // EventPublisher port (ADR-016)
const L = lk.lifecycle;
```

## 2. Register components (with dependencies + hooks)

```js
await L.register({
  componentId: 'db',
  componentType: 'datastore',
  startupPriority: 10, // higher starts earlier within a tier
  restartPolicy: 'on-failure',
  hooks: { initialize: async () => {}, start: async () => connectDb(), stop: async () => closeDb() },
});
await L.register({
  componentId: 'api',
  componentType: 'service',
  dependencies: ['db'], // api starts after db
  hooks: { start: async () => listen() },
});
// hooks are held in-process (never persisted); missing hooks are treated as no-ops
```

## 3. Start (deterministic dependency order) + stop (reverse)

```js
await L.start(); // topological order: db → api (deps first)
await L.stop(); // reverse order: api → db (graceful)
await L.start({ componentId: 'api' }); // start one — requires its deps already started
```

`start()` computes a **topological sort** of the dependency graph (dependencies first, ties
broken by `startupPriority` desc then id), initializes each component if needed, runs its
`start` hook, and transitions it to `started`. A missing dependency or cycle throws
`DependencyError`; starting a component whose dependency isn't started throws
`DependencyError` (health-aware). `stop()` runs the exact reverse order.

## 4. Initialize / restart / suspend / resume / status

```js
await L.initialize(); // run initialize hooks in dependency order (registered → initialized)
await L.restart({ componentId: 'api' }); // stop then start (emits ComponentRestarted)
await L.suspend({ componentId: 'api' }); // started → suspended
await L.resume({ componentId: 'api' }); // suspended → started
await L.status({ componentId: 'api' }); // → component model | null
```

## 5. Verify + health

```js
await L.verify({ namespace }); // → { ok, issues, startupOrder } — graph + checksum integrity
await L.health();
```

`verify` validates the dependency graph (missing/cycle), recomputes each component's
checksum, and returns the computed `startupOrder`.

## 6. Events (through the port only)

`ComponentRegistered`, `ComponentInitialized`, `ComponentStarted`, `ComponentStopped`,
`ComponentRestarted`, `LifecycleStateChanged`, `LifecycleVerified` — all via the Event
Backbone, producer `lifecycle`.

## 7. Observability

```js
lk.metrics.snapshot(); // registered + started components (gauges), initialized, stopped,
// restartOperations, failedTransitions, startup + shutdown latency, providerFailures, uptime
lk.metrics.prometheus();
```

## 8. SDK integration (ADR-018)

```js
const { toLifecyclePort } = require('../../src/application/lifecycle/sdkAdapter');
const portFactories = {
  'lifecycle:read': () => toLifecyclePort(lk.lifecycle, { owner: extId }),
  'lifecycle:manage': () => toLifecyclePort(lk.lifecycle, { owner: extId, canManage: true }),
};
// Inside the extension: this.lifecycle().start({ componentId })
```

Every call is forced into the extension's namespace (`ext.<owner>`). `status`/`verify`/
`list` require `lifecycle:read`; `initialize`/`start`/`stop`/`restart` require
`lifecycle:manage`. Component registration (with executable hooks) is administrative and not
exposed to extensions.

## Determinism, ordering & integrity

- **Deterministic** — startup is a topological sort with a priority tiebreak; shutdown is
  its exact reverse; the injected clock drives latency + timestamps.
- **State machine** — every transition is validated against the legal transition table;
  illegal transitions throw `TransitionError` and increment `failed_transitions`.
- **Health-aware** — a component starts only once all its dependencies are `started`.
- **Integrity** — every component carries a checksum; `start`/`verify` detect tampering, and
  `verify` also flags cycles and missing dependencies.

## Out of scope (future work behind the provider port)

Real stores (PostgreSQL/Storage/Redis/MongoDB/cloud), parallel same-tier startup, and
readiness/liveness probing are declared extension points, not implemented in this phase. The
memory provider is single-process.
