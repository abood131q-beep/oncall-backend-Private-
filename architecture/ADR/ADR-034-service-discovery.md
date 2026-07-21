# ADR-034 — Enterprise Service Discovery Kernel

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 15.5 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-021 (Storage), ADR-025 (Policy), ADR-026 (Audit), ADR-027
(Identity), ADR-033 (Observability)

## Context

The platform needs one deterministic way to register service instances, discover them by
capability and version, and resolve a health-aware endpoint with priority + weight routing
— independent of any registry product. This is the Service Discovery Kernel. It is **not
Consul / etcd / Kubernetes Service Discovery / DNS** — those are provider extension points,
not dependencies.

Service-discovery logic must never be embedded in individual services (each hard-coding
endpoints or rolling its own registry client). Instead it is a Kernel Service behind a
narrow port, so every service resolves the same way and the same (query, key) always yields
the same endpoint.

To stay strictly additive, the kernel lives under `discovery/` (new directories); no
existing kernel or application bounded context is touched.

## Decision

Add an additive Service Discovery Kernel. Nothing in it is on a hot path, so the platform
runs byte-identically whether or not it is instantiated.

**Domain (pure):**

- `service.js` — the Service value object (serviceId, namespace, serviceName, version,
  instanceId, endpoint, protocol, capabilities, tags, healthStatus, priority, weight,
  metadata, `checksum`, createdAt, updatedAt). The checksum covers the definition
  (identity + endpoint + capabilities + routing) but NOT the volatile healthStatus/
  timestamps — so a health update doesn't churn the endpoint-integrity checksum.
- `selection.js` — the deterministic match + order + select logic: capability/tag/metadata
  subset matching, semver version matching (reusing the platform semver kernel), priority-
  desc then weight-desc then instanceId ordering, and a content-hashed weighted pick so a
  stable key always lands on the same instance. Produces a discovery explanation.
- `errors.js` — `DiscoveryError`, `DiscoveryValidationError`, `ServiceNotFoundError`,
  `IntegrityError`.
- `events.js` — the event catalog (ServiceRegistered, ServiceUpdated, ServiceResolved,
  ServiceUnavailable, DiscoveryVerified); producer `discovery`.

**Application (ports & adapters):**

- `providerPort.js` — the persistence contract (putService / getService / listServices /
  removeService / health) + declared extension points (Consul, etcd, Kubernetes, DNS, cloud
  registry, custom). Providers store definitions; the engine owns all behavior.
- `providers/memoryProvider.js` — the implemented in-process service store.
- `cache.js` — the per-namespace provider cache (invalidated on register/update/remove).
- `metrics.js` — registered services + instances (gauges), discoveries, cache hits/misses,
  health changes, provider failures, resolution latency, uptime; Prometheus.
- `discoveryPort.js` — the abstraction contract (`assertDiscovery`): register, discover,
  resolve, list, verify, health.
- `discoveryService.js` — the kernel: deterministic registration, capability lookup,
  version-aware discovery, health-aware selection, priority + weight ordering, metadata
  filtering, endpoint verification, discovery explanation, and the provider cache. Per-
  service mutations are atomic via a serialization mutex.
- `sdkAdapter.js` — `toDiscoveryPort(discovery, { owner, canRead, canResolve })`: namespace
  isolation + `discovery:read` / `discovery:resolve` enforcement (no registration).
- `index.js` — `createDiscoveryPlatform(deps)` composition root.

## Kernel integration

Per §5, the Service Discovery Kernel integrates with other kernels **only through their
existing ports** — the Event Backbone (EventPublisher) for lifecycle events; the
authorization context from Identity (ADR-027) and Policy (ADR-025) governs `discovery:read`/
`discovery:resolve`; Audit (ADR-026) records events; Observability (ADR-033) can consume
health changes; Storage (ADR-021) is the model behind a durable provider; Configuration
(ADR-019) supplies registry config; Secrets (ADR-028) supplies provider credentials. It
imports no implementation classes.

## Alternatives rejected

- **Consul / etcd / Kubernetes / DNS as a dependency** — rejected: couples the platform to
  an external registry. They remain provider extension points behind the port.
- **Random / round-robin endpoint selection** — rejected: selection uses deterministic
  content hashing so the same key always resolves to the same instance and is testable.
- **Embedding endpoints in each service** — rejected: hard-codes topology and defeats
  health-aware routing.
- **Provider-side matching/selection** — rejected: matching, ordering, selection, and
  integrity live in the engine so behavior is uniform regardless of provider.

## Consequences

- New files under `src/domain/discovery/**` and `src/application/discovery/**`, plus
  `tests/unit/discovery.test.js` (+19 tests). Zero hot-path change; A/B byte-identical.
- Real registries (Consul/etcd/Kubernetes/DNS/cloud), active health-checking, and TTL-based
  instance expiry are future work behind the provider port. The memory provider + cache are
  single-process.

## Rollback

Delete `src/domain/discovery/`, `src/application/discovery/`, and
`tests/unit/discovery.test.js`. Nothing imports them at runtime, so removal is inert and
every prior kernel (ADR-016 … ADR-033) is unchanged. See `docs/DISCOVERY-ROLLBACK-PLAN.md`.
