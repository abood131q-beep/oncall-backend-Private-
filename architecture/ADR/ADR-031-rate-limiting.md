# ADR-031 — Enterprise Rate Limiting Kernel

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 15.2 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-021 (Storage), ADR-024 (Messaging), ADR-025 (Policy),
ADR-026 (Audit), ADR-027 (Identity), ADR-028 (Secrets)

## Context

The platform needs one deterministic way to admit or reject requests, track quotas, and
protect against abuse across every service — with multiple algorithms, burst handling, an
explanation for each decision, and an integrity guarantee on each policy, independent of
any transport. This is the Rate Limiting Kernel. It is **not Express Rate Limit / NGINX /
Redis middleware** — those are provider/persistence details, not dependencies.

Rate-limiting logic must never be embedded in individual services (each rolling its own
counter and window math). Instead it is a Kernel Service behind a narrow port, so every
service admits the same way and the same (policy, subject, time) always yields the same
decision.

To stay strictly additive, the kernel lives under `ratelimit/` (new directories); no
existing kernel or application bounded context is touched.

## Decision

Add an additive Rate Limiting Kernel. Nothing in it is on a hot path, so the platform runs
byte-identically whether or not it is instantiated.

**Domain (pure):**

- `policy.js` — the RatePolicy value object (policyId, name, namespace, subjectType, limit,
  window, algorithm, burstLimit, priority, metadata, version, `checksum`, plus a
  `capacity()` = burst-or-limit). A canonical content checksum gives integrity. Runtime
  fields (subject, currentUsage, remaining, resetTime) live on the evaluation RESULT.
- `algorithms.js` — the four deterministic, side-effect-free algorithms (fixed window,
  sliding window, token bucket, leaky bucket). Each is a pure function of (policy, counter
  state, now, cost) returning the decision plus the next state to persist (consumed and
  decayed).
- `errors.js` — `RateLimitError`, `RateLimitValidationError`, `PolicyNotFoundError`,
  `IntegrityError`.
- `events.js` — the rate event catalog (RatePolicyRegistered, RateLimitEvaluated,
  QuotaConsumed, QuotaExceeded, QuotaReset); producer `ratelimit`.

**Application (ports & adapters):**

- `providerPort.js` — the persistence contract (putPolicy / getPolicy / listPolicies /
  removePolicy / getCounter / putCounter / resetCounter / health) + declared extension
  points (Redis, Storage, PostgreSQL, MongoDB, custom). Providers persist policies +
  counters; the engine owns all behavior.
- `providers/memoryProvider.js` — the implemented in-process policy + counter store.
- `cache.js` — the bounded, write-through usage cache (removes a provider read from the hot
  admission path; every consume/reset writes both provider and cache).
- `metrics.js` — registered policies (gauge), evaluations, allowed, blocked, quota
  consumption, quota resets, provider failures, evaluation latency, uptime; Prometheus.
- `ratelimitPort.js` — the abstraction contract (`assertRateLimit`): registerPolicy,
  evaluate, consume, reset, verify, health.
- `ratelimitService.js` — the kernel: deterministic evaluation, burst handling, quota
  tracking, remaining calculation, priority resolution, explanation, and the usage cache;
  `evaluate` is a side-effect-free dry run, `consume` mutates the counter atomically per
  (policy, subject) via a serialization mutex; policy integrity is verified on resolve and
  on demand.
- `sdkAdapter.js` — `toRateLimitPort(ratelimit, { owner, canRead, canEvaluate })`:
  namespace isolation + `rate:read` / `rate:evaluate` enforcement (no authoring/reset).
- `index.js` — `createRateLimitPlatform(deps)` composition root.

## Kernel integration

Per §5, the Rate Limiting Kernel integrates with other kernels **only through their
existing ports** — the Event Backbone (EventPublisher) for policy + admission events; the
authorization context from Identity (ADR-027) and Policy (ADR-025) governs
`rate:read`/`rate:evaluate`; Audit (ADR-026) records events; Storage (ADR-021) is the model
behind a future counter store; Configuration (ADR-019) supplies policy definitions; Secrets
(ADR-028) supplies provider credentials; Messaging (ADR-024) can broadcast quota events. It
imports no implementation classes.

## Alternatives rejected

- **Express Rate Limit / NGINX / Redis middleware as a dependency** — rejected: couples the
  platform to an external rate-limiter. Redis/Storage/Postgres/Mongo remain provider
  extension points behind the port.
- **Wall-clock / randomised decisions** — rejected: the engine is deterministic with an
  injected clock, so the same (policy, subject, now) always yields the same decision.
- **Embedding counters in each service** — rejected: duplicates window/bucket math and
  defeats uniform admission + audit.
- **Provider-side evaluation** — rejected: algorithms, burst, quota, priority, and integrity
  live in the engine so behavior is uniform regardless of provider.

## Consequences

- New files under `src/domain/ratelimit/**` and `src/application/ratelimit/**`, plus
  `tests/unit/ratelimit.test.js` (+19 tests). Zero hot-path change; A/B byte-identical.
- Real counter stores (Redis/Storage/Postgres/Mongo), distributed atomic counters, and
  cross-node coordination are future work behind the provider port. The memory provider +
  cache are single-process (the serialization mutex prevents over-admission in-process).

## Rollback

Delete `src/domain/ratelimit/`, `src/application/ratelimit/`, and
`tests/unit/ratelimit.test.js`. Nothing imports them at runtime, so removal is inert and
every prior kernel (ADR-016 … ADR-030) is unchanged. See
`docs/RATELIMIT-ROLLBACK-PLAN.md` for the full procedure.
