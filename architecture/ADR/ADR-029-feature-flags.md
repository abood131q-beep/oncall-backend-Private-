# ADR-029 — Enterprise Feature Flag Platform

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 15.0 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-021 (Storage), ADR-025 (Policy), ADR-026 (Audit),
ADR-027 (Identity), ADR-028 (Secrets)

## Context

The platform needs one deterministic way to gate features: gradual rollout, version /
platform / region / tenant / environment targeting, ordered rules with conflict
resolution, and controlled activation — with an explanation for every decision and an
integrity guarantee on every definition. This is the Feature Flag Kernel. It is **not
LaunchDarkly / Unleash / Firebase Remote Config** and **not an experimentation
framework** — those are external products / a different problem; the relevant stores are
provider extension points, not dependencies.

Feature-flag logic must never be embedded in individual services (each parsing its own
env toggles). Instead it is a Kernel Service behind a narrow port, so every service
evaluates flags identically and the same context always yields the same decision.

To stay strictly additive, the kernel lives under `features/` (new directories); no
existing kernel or application bounded context is touched.

## Decision

Add an additive Feature Flag Kernel. Nothing in it is on a hot path, so the platform runs
byte-identically whether or not it is instantiated.

**Domain (pure):**

- `flag.js` — the FeatureFlag value object (flagId, name, namespace, description, state,
  defaultValue, offValue, rules, targeting, rollout, appVersion, platform, country,
  region, tenant, environment, priority, metadata, createdAt, updatedAt, version,
  `checksum`). A canonical `stableStringify` yields a content checksum for integrity;
  state transitions (`enable`/`disable`/`applyUpdate`) bump version + updatedAt +
  checksum.
- `targeting.js` — pure matchers: scalar/array membership, semver version ranges
  (reusing the platform semver kernel), AND-composition of conditions, and flag-level
  constraint matching with a `failed` reason.
- `rollout.js` — deterministic percentage rollout via content hashing (sha256 → bucket in
  `[0,10000)`); ramps are monotonic (raising the percentage only adds keys).
- `evaluation.js` — the deterministic evaluation engine with a full explanation
  (archived/disabled → targeting → ordered rules with per-rule rollout → flag rollout →
  default). Priority-desc, then declared order → conflict resolution.
- `errors.js` — `FeatureError`, `FeatureValidationError`, `FeatureNotFoundError`,
  `EvaluationError`, `IntegrityError`.
- `events.js` — the feature event catalog (FeatureRegistered, FeatureUpdated,
  FeatureEnabled, FeatureDisabled, FeatureEvaluated, FeatureRejected); producer
  `features`.

**Application (ports & adapters):**

- `providerPort.js` — persistence contract (putFlag / getFlag / listFlags / removeFlag /
  health) + declared extension points (Storage, PostgreSQL, Redis, MongoDB, cloud config,
  custom). Providers **store definitions only**; the engine owns all behavior.
- `providers/memoryProvider.js` — the implemented in-process definition store.
- `cache.js` — the bounded, checksum-keyed evaluation cache (FIFO eviction). Any
  definition change bumps the checksum, so stale entries can never be served.
- `metrics.js` — registered / enabled / disabled flags (gauges), evaluations, cache
  hits/misses, evaluation latency, provider failures, event-publication failures, uptime;
  Prometheus.
- `featuresPort.js` — the abstraction contract (`assertFeatures`): register, evaluate,
  enable, disable, update, list, verify, health.
- `featuresService.js` — the kernel: orchestrates provider + cache + metrics + events
  around the pure evaluation engine; mutations are atomic per-flag via a serialization
  mutex; definition integrity is verified on cache miss and on demand.
- `sdkAdapter.js` — `toFeaturePort(features, { owner, canRead, canEvaluate })`: namespace
  isolation + `feature:read` / `feature:evaluate` enforcement; read-only surface (no
  authoring).
- `index.js` — `createFeaturePlatform(deps)` composition root.

## Kernel integration

Per §5, the Feature Flag Kernel integrates with other kernels **only through their
existing ports** — the Event Backbone (EventPublisher) for lifecycle + evaluation events;
the authorization context from Identity (ADR-027) and Policy (ADR-025) governs who may
`feature:read`/`feature:evaluate`; Audit (ADR-026) can record feature events; Storage
(ADR-021) is the model behind a future persistence provider; Configuration (ADR-019) and
Secrets (ADR-028) supply definition sources / protected values; Messaging (ADR-024) can
fan out change notifications. It imports no implementation classes.

## Alternatives rejected

- **LaunchDarkly / Unleash / Firebase Remote Config as a dependency** — rejected: couples
  the platform to an external flag product. Their stores remain provider extension points.
- **A/B experimentation** — explicitly out of scope; the engine is deterministic
  evaluation + rollout, not experiment assignment/analysis.
- **Embedding toggles in each service** — rejected: duplicates targeting/rollout logic and
  defeats uniform evaluation + audit.
- **Random rollout** — rejected: rollout uses deterministic content hashing so the same
  key always lands in the same bucket and ramps are monotonic.
- **Provider-side evaluation** — rejected: evaluation, targeting, rollout, and integrity
  live in the engine so behavior is uniform regardless of provider.

## Consequences

- New files under `src/domain/features/**` and `src/application/features/**`, plus
  `tests/unit/features.test.js` (+18 tests). Zero hot-path change; A/B byte-identical.
- Real definition stores (Storage/PostgreSQL/Redis/MongoDB/cloud config), scheduled
  rollout ramps, and streaming change propagation are future work behind the provider
  port. The memory provider is single-process.

## Rollback

Delete `src/domain/features/`, `src/application/features/`, and
`tests/unit/features.test.js`. Nothing imports them at runtime, so removal is inert and
every prior kernel (ADR-016 … ADR-028) is unchanged. See
`docs/FEATURES-ROLLBACK-PLAN.md` for the full procedure and verification steps.
