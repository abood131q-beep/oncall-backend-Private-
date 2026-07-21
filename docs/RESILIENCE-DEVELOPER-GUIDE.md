# Enterprise Resilience Kernel — Developer Guide (ADR-036)

The Resilience Kernel is the platform's unified abstraction for deterministic fault
tolerance, execution protection, failure recovery, and resilience policy orchestration. It
is **not Hystrix/Resilience4j/Polly** and **not a retry middleware** — those are libraries.
It lives under `resilience/`, additive to every existing kernel.

## 1. Compose

```js
const { createResiliencePlatform } = require('../../src/application/resilience');
const rk = createResiliencePlatform({
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
});
const R = rk.resilience;
```

## 2. Register a policy

```js
const policy = await R.registerPolicy({
  name: 'trips-upstream',
  targetService: 'trips',
  strategy: 'composite', // composite | circuit_breaker | retry | timeout | fallback | bulkhead
  failureThreshold: 5, // failures before the circuit opens
  successThreshold: 2, // successes in half-open before it closes
  recoveryWindow: 30000, // ms before an open circuit trials half-open
  retryPolicy: { maxAttempts: 3 },
  backoffPolicy: { strategy: 'exponential', baseMs: 100, factor: 2, maxMs: 2000 },
  timeout: 1000, // ms budget per attempt
  fallbackStrategy: 'function',
  bulkhead: { maxConcurrent: 20 }, // 0 = unlimited
});
```

## 3. Execute a protected operation

```js
const r = await R.execute({
  policyId: policy.policyId,
  subject: 'user-1', // optional — circuit state is tracked per (policy, subject)
  fn: async () => callTripsService(), // the protected operation
  fallback: async ({ reason, error }) => cachedTrips(), // optional
  args: { ... }, // passed to fn(args)
});
// → { ok: true, executionId, result, attempts, fallback: false }
// on fallback: { ok: true, result, fallback: true, reason: 'circuit_open' | 'bulkhead' | 'failure' }
```

The engine applies, in order: **bulkhead** admission → **circuit** gate → **retry loop**
(each attempt bounded by **timeout**, failures **classified** for retriability) → on final
failure the **circuit** records it and a **fallback** runs if provided (else the error
throws). A `CircuitOpenError` / `BulkheadFullError` is thrown when short-circuited with no
fallback.

## 4. Evaluate (dry run) + reset

```js
await R.evaluate({ policyId, subject }); // → { circuit, allowed, failures, successes, openedAt, wouldTransition }
await R.reset({ policyId, subject }); // clear circuit state → RecoveryCompleted
```

## 5. Verify + health

```js
await R.verify({ namespace }); // → { ok, issues } — policy checksum integrity
await R.health();
```

## 6. Events (through the port only)

`PolicyRegistered`, `ExecutionStarted`, `ExecutionSucceeded`, `ExecutionFailed`,
`CircuitOpened`, `CircuitHalfOpened`, `CircuitClosed`, `FallbackExecuted`,
`RecoveryCompleted` — all via the Event Backbone, producer `resilience`.

## 7. Observability

```js
rk.metrics.snapshot(); // registeredPolicies (gauge), protected/successful/failed executions,
// retryAttempts, fallbackExecutions, openCircuits + closedCircuits (gauges), timeouts,
// bulkheadRejections, providerFailures, uptime
rk.metrics.prometheus();
```

## 8. SDK integration (ADR-018)

```js
const { toResiliencePort } = require('../../src/application/resilience/sdkAdapter');
const portFactories = {
  'resilience:read': () => toResiliencePort(rk.resilience, { owner: extId, canExecute: false }),
  'resilience:execute': () => toResiliencePort(rk.resilience, { owner: extId }),
};
// Inside the extension: this.resilience().execute({ policyId, fn })
```

Every call is forced into the extension's namespace (`ext.<owner>`). `execute` requires
`resilience:execute`; `evaluate`/`verify` require `resilience:read`. Policy authoring
(`registerPolicy`) and `reset` are administrative and not exposed to extensions.

## Determinism, circuit & bulkhead

- **Deterministic** — an injected clock drives timeout, backoff, and recovery-window
  decisions; the same failure sequence always produces the same circuit transitions.
- **Circuit breaker** — closed → open at `failureThreshold`; open short-circuits until
  `recoveryWindow` elapses, then a half-open trial; `successThreshold` closes it, any
  failure re-opens it. State is tracked per (policy, subject) with atomic transitions.
- **Bulkhead** — bounds real in-flight concurrency per policy; excess is rejected (or falls
  back) — verified with concurrent executions.
- **Integrity** — every policy carries a checksum; `execute`/`evaluate` verify it and
  `verify()` checks a whole namespace.

## Out of scope (future work behind the provider port)

Real state stores (Redis/PostgreSQL/Storage/MongoDB), scheduler-driven half-open probing,
and adaptive/percentage-based breakers are declared extension points, not implemented in
this phase. Backoff delays are computed but not slept in-process (a Scheduler-driven retry
is future work). The memory provider is single-process.
