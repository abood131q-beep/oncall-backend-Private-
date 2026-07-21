# ADR-037 — Enterprise Service Mesh Kernel

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 15.8 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-025 (Policy), ADR-026 (Audit), ADR-027 (Identity), ADR-031 (Rate Limiting), ADR-034
(Service Discovery), ADR-035 (API Gateway), ADR-036 (Resilience) — integrated through
their existing ports.

## Context

The platform needs one deterministic way to govern service-to-service communication:
declare connection policies (traffic, routing, security), validate mutual identity,
propagate secure context, delegate retries, enforce timeouts, and account every invocation
— independent of any sidecar/proxy product. This is the Service Mesh Kernel. It is **not
Istio / Linkerd / Consul Connect** and **not a network proxy** — those are provider
extension points / a data-plane concern; this kernel is the deterministic control-plane
abstraction call sites invoke through.

Service-mesh logic must never be embedded in application services (each re-implementing
mTLS checks and routing). Instead it is a Kernel Service behind a narrow port; call sites
hand the operation to `invoke()` and the engine applies the connection's policies.

To stay strictly additive, the kernel lives under `mesh/` (new directories); no existing
kernel or application bounded context is touched.

## Decision

Add an additive Service Mesh Kernel. Nothing in it is on a hot path, so the platform runs
byte-identically whether or not it is instantiated.

**Domain (pure):**

- `connection.js` — the Connection value object (connectionId, namespace, sourceService,
  destinationService, protocol, trafficPolicy, routingPolicy, securityPolicy, retryPolicy,
  timeout, priority, connectionState, metadata, version, `checksum`, createdAt, updatedAt)
  with `establish`/`close` transitions. The checksum covers the definition but not the
  volatile connectionState/timestamps.
- `policies.js` — deterministic policy evaluation: security admission (mutual identity via
  `requireIdentity` + `allowedSources`, mTLS assertion) and the routing decision.
- `errors.js` — `MeshError`, `MeshValidationError`, `ConnectionNotFoundError`,
  `MeshRejectedError` (carries a `reason`), `IntegrityError`.
- `events.js` — the event catalog (ConnectionRegistered, ConnectionEstablished,
  InvocationStarted, InvocationCompleted, InvocationFailed, ConnectionClosed, MeshVerified);
  producer `mesh`.

**Application (ports & adapters):**

- `providerPort.js` — the persistence contract (putConnection / getConnection /
  listConnections / removeConnection / health) + declared extension points (Istio, Linkerd,
  Consul Connect, cloud mesh, custom). Providers store definitions; the engine owns all
  behavior.
- `providers/memoryProvider.js` — the implemented in-process connection store.
- `metrics.js` — registered + active connections (gauges), invocations, successful + failed
  invocations, policy violations, provider failures, connection latency, uptime; Prometheus.
- `meshPort.js` — the abstraction contract (`assertMesh`): registerPolicy, connect, invoke,
  disconnect, verify, health.
- `meshService.js` — the kernel: deterministic service invocation, connection lifecycle,
  policy evaluation, traffic-routing abstraction, connection validation, identity + secure
  context propagation, retry delegation, timeout enforcement, and invocation history. Cross-
  kernel integration is through **injected ports** only. Connection mutations are atomic via
  a serialization mutex; traffic concurrency is bounded by an engine-held counter.
- `sdkAdapter.js` — `toMeshPort(mesh, { owner, canInvoke, canRead })`: namespace isolation +
  `mesh:invoke` / `mesh:read` enforcement (no authoring/lifecycle).
- `index.js` — `createMeshPlatform(deps)` composition root (accepts `ports`).

## Kernel integration

Per §5, the Service Mesh Kernel integrates with other kernels **only through their existing
ports**, all injected as `deps.ports`: Identity (ADR-027) `resolve` for mutual identity +
context propagation; Policy (ADR-025) `evaluate` for security enforcement; Rate Limiting
(ADR-031) `consume` for traffic policy; Service Discovery (ADR-034) `resolve` for the
destination endpoint; Resilience (ADR-036) `execute` for retry delegation; the API Gateway
(ADR-035) is a natural caller; the Event Backbone (EventPublisher) carries its events; Audit
(ADR-026) records them. It imports no implementation classes.

## Alternatives rejected

- **Istio / Linkerd / Consul Connect as a dependency** — rejected: couples the platform to
  an external mesh. They remain provider extension points behind the port.
- **Being a network proxy / data plane** — rejected: this kernel is the deterministic
  control-plane abstraction; the transport binds at the edge. `invoke` runs the supplied
  operation under the connection's policies.
- **Embedding mTLS/routing in each service** — rejected: duplicates security logic and
  defeats uniform governance + audit.
- **Provider-side invocation** — rejected: policy, routing, identity, retry delegation, and
  integrity live in the engine so behavior is uniform regardless of provider.

## Consequences

- New files under `src/domain/mesh/**` and `src/application/mesh/**`, plus
  `tests/unit/mesh.test.js` (+17 tests). Zero hot-path change; A/B byte-identical.
- Real mesh backends (Istio/Linkerd/Consul/cloud), an actual data-plane binding, and
  streaming/bidirectional invocation are future work behind the provider port + edge. The
  memory provider is single-process.

## Rollback

Delete `src/domain/mesh/`, `src/application/mesh/`, and `tests/unit/mesh.test.js`. Nothing
imports them at runtime, so removal is inert and every prior kernel (ADR-016 … ADR-036) is
unchanged. See `docs/MESH-ROLLBACK-PLAN.md`.
