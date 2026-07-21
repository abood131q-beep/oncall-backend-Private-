# ADR-035 — Enterprise API Gateway Kernel

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 15.6 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-025 (Policy), ADR-026 (Audit), ADR-027 (Identity), ADR-029 (Feature Flags), ADR-031
(Rate Limiting), ADR-034 (Service Discovery) — all integrated through their existing ports.

## Context

The platform needs one deterministic way to route requests: match a request to a route,
propagate identity context, enforce policy / rate-limit / feature gates, resolve the target
via service discovery, run a middleware pipeline, and honor timeouts — independent of any
gateway product. This is the API Gateway Kernel. It is **not Kong / Envoy / NGINX** and
**not an HTTP server** — those are provider extension points / a transport concern; this
kernel resolves and orchestrates a request and returns the dispatch decision.

Gateway logic must never be embedded in application services (each parsing routes and
re-implementing auth). Instead it is a Kernel Service behind a narrow port, so every
request is routed the same way and the same (method, path, version) always resolves the
same route.

To stay strictly additive, the kernel lives under `gateway/` (new directories); no existing
kernel or application bounded context is touched.

## Decision

Add an additive API Gateway Kernel. Nothing in it is on a hot path, so the platform runs
byte-identically whether or not it is instantiated.

**Domain (pure):**

- `route.js` — the Route value object (routeId, namespace, method, path, version,
  targetService, targetEndpoint, policies, middlewareChain, authRequired, rateLimitPolicy,
  timeout, priority, metadata, `checksum`, createdAt, updatedAt).
- `matching.js` — deterministic route matching: `:param` path captures + `*` wildcard,
  method match, bidirectional semver version matching (reusing the platform semver kernel),
  and ordering by priority desc, then path specificity, then routeId.
- `errors.js` — `GatewayError`, `GatewayValidationError`, `RouteNotFoundError`,
  `GatewayRejectedError` (carries a `reason`), `IntegrityError`.
- `events.js` — the event catalog (RouteRegistered, RouteUpdated, RouteResolved,
  RequestDispatched, GatewayRejected, GatewayVerified); producer `gateway`.

**Application (ports & adapters):**

- `providerPort.js` — the persistence contract (putRoute / getRoute / listRoutes /
  removeRoute / health) + declared extension points (Kong, Envoy, NGINX, cloud gateway,
  custom). Providers store route definitions; the engine owns all behavior.
- `providers/memoryProvider.js` — the implemented in-process route store.
- `cache.js` — the per-namespace route cache (invalidated on register/update/remove).
- `metrics.js` — registered routes (gauge), dispatches, successful + failed resolutions,
  policy rejections, provider failures, routing latency, uptime; Prometheus.
- `gatewayPort.js` — the abstraction contract (`assertGateway`): registerRoute, resolve,
  dispatch, listRoutes, verify, health.
- `gatewayService.js` — the kernel: deterministic route resolution, version-aware routing, a
  middleware pipeline, policy enforcement, identity context propagation, rate-limit +
  feature-flag + service-discovery integration (through **injected kernel ports** only),
  request validation, timeout handling, and diagnostics. Per-route mutations are atomic via
  a serialization mutex.
- `sdkAdapter.js` — `toGatewayPort(gateway, { owner, canRead, canDispatch })`: namespace
  isolation + `gateway:read` / `gateway:dispatch` enforcement (no route/middleware
  registration).
- `index.js` — `createGatewayPlatform(deps)` composition root (accepts `ports`).

## Kernel integration

Per §5, the API Gateway Kernel integrates with other kernels **only through their existing
ports**, all dependency-injected as `deps.ports`: Identity (ADR-027) `resolve` for auth +
context propagation; Policy (ADR-025) `evaluate` for enforcement; Rate Limiting (ADR-031)
`consume`; Feature Flags (ADR-029) `evaluate`; Service Discovery (ADR-034) `resolve` for the
target endpoint; the Event Backbone (EventPublisher) for lifecycle events; Audit (ADR-026)
records them. Each port is optional — if not wired, that enforcement step is a deterministic
pass-through. It imports no implementation classes.

## Alternatives rejected

- **Kong / Envoy / NGINX as a dependency** — rejected: couples the platform to an external
  gateway. They remain provider extension points behind the port.
- **Being an HTTP server** — rejected: this kernel decides routing + orchestration
  deterministically; the transport binds it at the edge. A registered upstream handler is
  optional and only run when present.
- **Embedding routing in each service** — rejected: duplicates auth/policy/routing and
  defeats uniform enforcement + audit.
- **Provider-side routing** — rejected: matching, middleware, policy, and integrity live in
  the engine so behavior is uniform regardless of provider.

## Consequences

- New files under `src/domain/gateway/**` and `src/application/gateway/**`, plus
  `tests/unit/gateway.test.js` (+19 tests). Zero hot-path change; A/B byte-identical.
- Real gateway backends (Kong/Envoy/NGINX/cloud), an actual HTTP transport binding, and
  streaming/websocket routing are future work behind the provider port + edge adapter. The
  memory provider + cache are single-process.

## Rollback

Delete `src/domain/gateway/`, `src/application/gateway/`, and `tests/unit/gateway.test.js`.
Nothing imports them at runtime, so removal is inert and every prior kernel (ADR-016 …
ADR-034) is unchanged. See `docs/GATEWAY-ROLLBACK-PLAN.md`.
