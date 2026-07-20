# ADR-025 — Enterprise Policy Engine

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-20
**Phase:** 14.6 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-020 (Scheduler), ADR-021 (Storage), ADR-022 (Lock),
ADR-023 (Workflow), ADR-024 (Messaging)

## Context

Decisions — "may this ride be created?", "can this extension publish here?", "is this action
allowed under current conditions?" — are today scattered as ad-hoc `if` checks across
services. The Policy Kernel centralizes them: one platform-wide engine that evaluates
decisions **consistently and deterministically** across all Kernel Services. It is **not an
authorization framework**, **not a rule engine**, and **not tied to OPA/Cedar/Casbin**.

## Decision

Add an additive, framework-free Policy Engine. Nothing in it is on a hot path, so the platform
runs byte-identically whether or not the engine is instantiated.

**Domain (pure):**

- `condition.js` — a small, deterministic condition language: leaf comparisons
  (eq/ne/gt/gte/lt/lte/in/nin/contains/exists/regex) over dotted context paths, composed with
  `all`/`any`/`not`, plus a custom `fn` predicate.
- `policy.js` — the Policy value object (policyId, name, version, namespace, scope, priority,
  condition, effect allow|deny, metadata, state) with an integrity **checksum**.
- `decision.js` — the deterministic decision engine: default-deny, priority ordering, conflict
  resolution (deny-overrides | allow-overrides | first-applicable | priority), short-circuit,
  composition, and a full explanation trace.
- `errors.js` — `PolicyError`, `PolicyDefinitionError`, `ConditionError`.
- `events.js` — the policy event catalog (PolicyRegistered/Updated/Enabled/Disabled/
  Evaluated/Rejected); producer `policy`.

**Application (ports & adapters):**

- `providerPort.js` — the policy-**definition** store contract (`put/get/remove/list/health`)
  + declared extension points (OPA, Cedar, Casbin, Custom). Providers store definitions only;
  evaluation stays in the engine.
- `providers/memory.js` — the implemented in-process definition store.
- `metrics.js` — policies registered/evaluated, allow/deny decisions, evaluation latency,
  decision-cache hits/misses; Prometheus.
- `policyPort.js` — the abstraction contract (`assertPolicy`).
- `policyService.js` — the kernel: `register/evaluate/explain/enable/disable/list/health`
  (+`verify`). Holds live policy entities for evaluation, mirrors definitions to the provider,
  and caches decisions (generation-invalidated). Lifecycle events through the EventPublisher
  port only.
- `sdkAdapter.js` — `toPolicyPort(policy, { owner, canRead, canEvaluate })`: namespace
  isolation + `policy:read`/`policy:evaluate` capability enforcement.
- `index.js` — `createPolicyPlatform(deps)` composition root.

## Kernel integration

Per §5, the Policy Kernel integrates with other kernels **only through their existing ports**
— the Event Backbone (EventPublisher) for lifecycle events, and optionally Configuration/
Storage/etc. for policy sourcing and durability. It imports no implementation classes.

## Alternatives rejected

- **OPA / Cedar / Casbin** — rejected as a dependency: couples to an external policy runtime.
  They remain declared provider extension points (definition storage), but evaluation is the
  engine's own deterministic logic.
- **Embedding checks in services** — rejected: that is the scattered logic this ADR replaces.
- **Provider-side evaluation** — rejected: providers store definitions only; the engine
  decides, so behavior is uniform regardless of the active provider.

## Consequences

- New files under `src/domain/policy/**` and `src/application/policy/**`, plus
  `tests/unit/policy.test.js` (+15 tests). Zero hot-path change; A/B byte-identical.
- Adopting a policy for a real decision point is a separate, opt-in wiring step behind this port.

## Rollback

Delete `src/domain/policy/`, `src/application/policy/`, and `tests/unit/policy.test.js`.
Nothing imports them at runtime, so removal is inert and every prior kernel is unchanged.
