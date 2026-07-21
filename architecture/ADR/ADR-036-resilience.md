# ADR-036 — Enterprise Resilience Kernel

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 15.7 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-020 (Scheduler), ADR-026 (Audit), ADR-033 (Observability), ADR-034 (Service
Discovery), ADR-035 (API Gateway) — integrated through their existing ports.

## Context

The platform needs one deterministic way to protect executions against faults: trip a
circuit on repeated failure, retry with backoff, bound calls with a timeout, fall back
gracefully, and isolate concurrency with a bulkhead — independent of any resilience
library. This is the Resilience Kernel. It is **not Hystrix / Resilience4j / Polly** and
**not a retry middleware** — those are libraries; this is a Kernel Service behind a narrow
port so every service is protected the same way and the same failure sequence always
produces the same circuit decision.

Resilience logic must never be embedded in application services (each rolling its own retry
loop and breaker). Instead it is a Kernel Service; call sites hand the protected operation
to `execute()` and the engine applies the policy.

To stay strictly additive, the kernel lives under `resilience/` (new directories); no
existing kernel or application bounded context is touched.

## Decision

Add an additive Resilience Kernel. Nothing in it is on a hot path, so the platform runs
byte-identically whether or not it is instantiated.

**Domain (pure):**

- `policy.js` — the ResiliencePolicy value object (policyId, namespace, targetService,
  strategy, retryPolicy, backoffPolicy, timeout, fallbackStrategy, failureThreshold,
  successThreshold, recoveryWindow, bulkhead, priority, metadata, version, `checksum`) with
  a deterministic `nextDelayMs` backoff.
- `circuit.js` — the pure circuit-breaker state machine (closed / open / half_open) with
  `canAttempt` / `onSuccess` / `onFailure` transitions, functions of (state, policy, now).
- `classify.js` — deterministic failure classification (retriable vs non-retriable; timeout).
- `errors.js` — `ResilienceError`, `ResilienceValidationError`, `PolicyNotFoundError`,
  `CircuitOpenError`, `BulkheadFullError`, `ExecutionTimeoutError`, `IntegrityError`.
- `events.js` — the event catalog (PolicyRegistered, ExecutionStarted, ExecutionSucceeded,
  ExecutionFailed, CircuitOpened, CircuitHalfOpened, CircuitClosed, FallbackExecuted,
  RecoveryCompleted); producer `resilience`.

**Application (ports & adapters):**

- `providerPort.js` — the persistence contract (putPolicy / getPolicy / listPolicies /
  removePolicy / getState / putState / resetState / health) + declared extension points
  (Redis, PostgreSQL, Storage, MongoDB, custom). Providers persist policies + circuit state;
  the engine owns all behavior.
- `providers/memoryProvider.js` — the implemented in-process policy + state store.
- `metrics.js` — registered policies (gauge), protected / successful / failed executions,
  retry attempts, fallback executions, open + closed circuits (gauges), timeouts, provider
  failures, uptime; Prometheus.
- `resiliencePort.js` — the abstraction contract (`assertResilience`): registerPolicy,
  execute, evaluate, reset, verify, health.
- `resilienceService.js` — the kernel: deterministic execution, circuit breaker, retry with
  backoff, execution timeout, fallback, bulkhead isolation, failure classification, recovery
  evaluation, policy verification, and execution history. Circuit transitions are atomic via
  a per-(policy,subject) serialization mutex; the protected call runs outside the lock so the
  bulkhead governs real concurrency.
- `sdkAdapter.js` — `toResiliencePort(resilience, { owner, canExecute, canRead })`: namespace
  isolation + `resilience:execute` / `resilience:read` enforcement (no authoring/reset).
- `index.js` — `createResiliencePlatform(deps)` composition root.

## Kernel integration

Per §5, the Resilience Kernel integrates with other kernels **only through their existing
ports**: it protects calls made by the API Gateway (ADR-035), Service Discovery (ADR-034),
Messaging (ADR-024), Workflow (ADR-023), Background Jobs (ADR-032) etc. by wrapping the
supplied operation; the Scheduler (ADR-020) can drive recovery windows; Observability
(ADR-033) consumes its metrics/events; the Event Backbone (EventPublisher) carries its
events; Audit (ADR-026) records them. It imports no implementation classes — call sites hand
it a plain `fn`.

## Alternatives rejected

- **Hystrix / Resilience4j / Polly as a dependency** — rejected: couples the platform to an
  external library. Their backends (Redis/Postgres/Storage/Mongo) remain provider extension
  points.
- **Wall-clock retry sleeps** — rejected: the engine is deterministic; backoff delays are
  computed (advisory) and the injected clock drives timeout + recovery decisions, so tests
  are reproducible.
- **Embedding breakers in each service** — rejected: duplicates state machines and defeats
  uniform recovery + audit.
- **Provider-side circuit logic** — rejected: the breaker, retry, timeout, fallback, and
  bulkhead live in the engine so behavior is uniform regardless of provider.

## Consequences

- New files under `src/domain/resilience/**` and `src/application/resilience/**`, plus
  `tests/unit/resilience.test.js` (+20 tests). Zero hot-path change; A/B byte-identical.
- Real state stores (Redis/Postgres/Storage/Mongo), scheduler-driven half-open probing, and
  adaptive/percentage-based breakers are future work behind the provider port. The memory
  provider is single-process.

## Rollback

Delete `src/domain/resilience/`, `src/application/resilience/`, and
`tests/unit/resilience.test.js`. Nothing imports them at runtime, so removal is inert and
every prior kernel (ADR-016 … ADR-035) is unchanged. See `docs/RESILIENCE-ROLLBACK-PLAN.md`.
