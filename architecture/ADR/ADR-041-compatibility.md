# ADR-041 — Enterprise Compatibility Kernel

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 15.12 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-026 (Audit), ADR-033 (Observability), ADR-034 (Discovery), ADR-035 (API Gateway) —
integrated through their existing ports. Reuses `src/domain/extensions/semver.js` and
`src/domain/extensions/integrity.js`.

## Context

As the platform accreted Kernel Services (ADR-016 … ADR-040), each evolved its own
contracts, versions, and capabilities. Nothing governed whether a consumer speaking an
older or newer version of a contract remained compatible, whether a requested set of
capabilities could be satisfied, or how a version is deprecated and retired. That
knowledge lived implicitly in code and human memory.

The Compatibility Kernel makes this explicit and deterministic: it is the platform-wide
authority for **contract compatibility, capability negotiation, version evolution,
deprecation governance, and backward/forward compatibility** across all Kernel Services.
It is **not semantic versioning** (semver is a comparison primitive it reuses, not the
system), **not npm package management**, **not API versioning middleware**, and **not a
migration framework**. It moves no traffic and transforms no payloads — it answers, given
a contract and a request, whether they are compatible, and what version/capabilities they
should agree on.

Compatibility logic must never be embedded in application services (each hard-coding its
own version checks). Instead it is a Kernel Service behind a narrow port, so every
compatibility decision is computed the same way in one place.

To stay strictly additive, the kernel lives under `compatibility/` (new directories); no
existing kernel or application bounded context is touched.

## Decision

Add an additive Compatibility Kernel. Nothing in it is on a hot path, so the platform runs
byte-identically whether or not it is instantiated.

**Domain (pure):**

- `contract.js` — the Contract value object (contractId, namespace, component, version,
  supportedVersions, capabilities, compatibilityLevel [strict/backward/forward/full/none],
  deprecationStatus [active/deprecated/retired], replacementContract, metadata, `checksum`,
  createdAt, updatedAt) with a governed `deprecate` transition. The checksum covers the
  full definition **including** deprecationStatus, so a deprecation is tamper-evident.
- `compatibility.js` — pure, deterministic `evaluate(contract, {version, capabilities})` →
  `{compatible, versionOk, backward, forward, missingCapabilities, level, deprecated}`,
  plus `resolveVersion` (highest supported version satisfying a request) and
  `negotiateCapabilities` (intersection with the offered set). Version comparison reuses
  the platform semver kernel; no wall-clock, no I/O.
- `errors.js` — `CompatibilityError`, `CompatibilityValidationError`,
  `ContractNotFoundError`, `NegotiationError`, `IntegrityError`.
- `events.js` — the event catalog (ContractRegistered, CompatibilityVerified,
  CapabilityNegotiated, VersionDeprecated, CompatibilityViolationDetected); producer
  `compatibility`.

**Application (ports & adapters):**

- `providerPort.js` — the persistence contract (putContract / getContract / listContracts /
  removeContract / health) + declared extension points (PostgreSQL, Storage, Redis,
  MongoDB, cloud registry, custom). Providers persist contract metadata only; the engine
  owns all compatibility behavior.
- `providers/memoryProvider.js` — the implemented in-process contract store.
- `metrics.js` — registered contracts (gauge), evaluations + incompatible outcomes,
  verifications, negotiations, deprecations, detected violations, provider/event/integrity
  failures, evaluation latency, uptime; Prometheus.
- `compatibilityPort.js` — the abstraction contract (`assertCompatibility`):
  registerContract, evaluate, negotiate, deprecate, verify, health.
- `compatibilityService.js` — the kernel: deterministic evaluation against a compatibility
  level, capability negotiation, version resolution, deprecation governance, checksum
  integrity verification, violation detection, and compatibility history. Events flow only
  through the EventPublisher port. Writes are atomic per namespace via a serialization
  mutex; the clock is injected.
- `sdkAdapter.js` — `toCompatibilityPort(compatibility, { owner, canRead, canVerify })`:
  namespace isolation + `compatibility:read` / `compatibility:verify` enforcement (no
  registration, no deprecation).
- `index.js` — `createCompatibilityPlatform(deps)` composition root.

## Kernel integration

Per the phase spec, the Compatibility Kernel integrates with other kernels **only through
their existing ports** and imports no implementation classes: the Event Backbone
(EventPublisher) carries compatibility events; Discovery (ADR-034) and the API Gateway
(ADR-035) can consult compatibility decisions during version-aware routing; Observability
(ADR-033) consumes evaluation metrics; Audit (ADR-026) records deprecation governance
events. It reuses the shared `semver` and `integrity.checksum` extensions rather than
introducing new comparison or hashing logic.

## Alternatives rejected

- **Semantic versioning alone** — rejected: semver compares two version strings but says
  nothing about capability sets, deprecation governance, or a contract's declared
  compatibility level. It is reused as a primitive, not the system.
- **npm / package managers** — rejected: those resolve dependency trees for install-time
  artifacts; this kernel governs runtime contract compatibility between live services.
- **API versioning middleware** — rejected: middleware rewrites/routes requests on a hot
  path; this kernel is an off-path decision authority that emits a deterministic verdict.
- **Migration framework** — rejected: migrations mutate state forward; this kernel neither
  mutates consumer state nor transforms payloads.
- **Per-service ad-hoc version checks** — rejected: duplicates comparison logic and drifts;
  compatibility is decided once, deterministically, from the contract definition.
- **Provider-side evaluation** — rejected: all compatibility behavior lives in the engine
  so verdicts are uniform regardless of provider.

## Consequences

- New files under `src/domain/compatibility/**` and `src/application/compatibility/**`,
  plus `tests/unit/compatibility.test.js` (+32 tests). Zero hot-path change; A/B
  byte-identical.
- Real stores (Postgres/Storage/Redis/Mongo/cloud), cross-namespace contract federation,
  and automated deprecation-window enforcement are future work behind the provider port.
  The memory provider is single-process.

## Rollback

Delete `src/domain/compatibility/`, `src/application/compatibility/`, and
`tests/unit/compatibility.test.js`. Nothing imports them at runtime, so removal is inert
and every prior kernel (ADR-016 … ADR-040) is unchanged. See
`docs/COMPATIBILITY-ROLLBACK-PLAN.md`.
