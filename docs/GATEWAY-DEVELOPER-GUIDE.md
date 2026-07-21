# Enterprise API Gateway Kernel — Developer Guide (ADR-035)

The API Gateway Kernel is the platform's unified abstraction for deterministic request
routing, endpoint resolution, middleware orchestration, and gateway policy enforcement. It
is **not Kong/Envoy/NGINX** and **not an HTTP server** — those are provider extension points
/ an edge transport. It lives under `gateway/`, additive to every existing kernel.

## 1. Compose (with optional kernel ports)

```js
const { createGatewayPlatform } = require('../../src/application/gateway');
const gk = createGatewayPlatform({
  publisher, // EventPublisher port (ADR-016)
  ports: {
    // all optional — each enforcement step is skipped if its port is absent
    identity, // ADR-027: resolve({ sessionId, token }) → { ok, context }
    policy, // ADR-025: evaluate({ policyId, context, action, resource }) → { effect }
    ratelimit, // ADR-031: consume({ policyId, subject }) → { allowed }
    features, // ADR-029: evaluate({ name, context }) → { served, value }
    discovery, // ADR-034: resolve({ serviceName, key }) → { selected: { endpoint } }
  },
});
const G = gk.gateway;
```

## 2. Register middleware + routes

```js
G.registerMiddleware('requestId', async (ctx) => { ctx.request.headers['x-req'] = 'r1'; });

const route = await G.registerRoute({
  method: 'GET',
  path: '/trips/:id', // :param captures; '*' wildcard segment
  version: '>=1.0.0', // served version (semver range or exact; '*' = any)
  targetService: 'trips', // resolved via Service Discovery, OR:
  // targetEndpoint: 'http://trips:8080',
  authRequired: true, // requires Identity resolution
  policies: ['trips:read'], // evaluated by Policy
  rateLimitPolicy: 'api', // consumed via Rate Limiting
  middlewareChain: ['requestId'], // runs in order
  timeout: 30000,
  priority: 10, // higher wins on overlapping paths
  metadata: { featureFlag: 'new-trips' }, // gated by Feature Flags when present
  handler: async (ctx) => ({ ok: true }), // optional upstream handler (not persisted)
});
```

## 3. Resolve (match only)

```js
const r = await G.resolve({ method: 'GET', path: '/trips/42', version: '1.5.0' });
// → { namespace, route, params: { id: '42' }, candidateCount }
```

Ordering is deterministic: highest `priority`, then most-specific path (more static
segments), then routeId.

## 4. Dispatch (resolve → enforce → orchestrate)

```js
const d = await G.dispatch({
  method: 'GET',
  path: '/trips/42',
  version: '1.5.0',
  token: '...', // for auth
  subject: 'user-1', // for rate-limit + discovery key
  headers: {},
  correlationId: 'req-9',
});
// → { status: 'dispatched', routeId, target: { service, endpoint }, params,
//     identity, middlewareTrace, result, latencyMs }
```

Dispatch runs, in order: route integrity → authentication (identity context propagation) →
feature-flag gate → policy enforcement → rate limiting → target resolution (service
discovery) → middleware pipeline → optional handler → timeout check. Any failed step throws
`GatewayRejectedError` (with a `reason`: `unauthenticated`, `feature_disabled`,
`policy_denied`, `rate_limited`, `service_unavailable`, `middleware_missing`,
`middleware_error`, `timeout`) and emits `GatewayRejected`.

## 5. List + verify + health

```js
await G.listRoutes({ namespace });
await G.verify({ namespace }); // → { ok, issues } — route checksum + middleware integrity
await G.health();
```

## 6. Events (through the port only)

`RouteRegistered`, `RouteUpdated`, `RouteResolved`, `RequestDispatched`, `GatewayRejected`,
`GatewayVerified` — all via the Event Backbone, producer `gateway`.

## 7. Observability

```js
gk.metrics.snapshot(); // registeredRoutes (gauge), dispatches, successful/failed
// resolutions, policyRejections, cacheHits/Misses, providerFailures, routing latency, uptime
gk.metrics.prometheus();
```

## 8. SDK integration (ADR-018)

```js
const { toGatewayPort } = require('../../src/application/gateway/sdkAdapter');
const portFactories = {
  'gateway:read': () => toGatewayPort(gk.gateway, { owner: extId, canDispatch: false }),
  'gateway:dispatch': () => toGatewayPort(gk.gateway, { owner: extId }),
};
// Inside the extension: this.gateway().dispatch({ method, path })
```

Every call is forced into the extension's namespace (`ext.<owner>`). `resolve`/`listRoutes`/
`verify` require `gateway:read`; `dispatch` requires `gateway:dispatch`. Route + middleware
registration are administrative and not exposed to extensions.

## Determinism, integration & integrity

- **Deterministic** — matching + ordering are pure; timeouts use the injected clock. The
  same (method, path, version) always resolves the same route.
- **Integration through ports only** — identity/policy/rate-limit/feature/discovery are
  injected kernel ports; the gateway calls only their public methods and never imports a
  kernel's implementation.
- **Integrity** — every route carries a checksum; `verify()` recomputes it and confirms
  every referenced middleware is registered (middleware integrity). Dispatch verifies the
  route checksum before trusting it.

## Out of scope (future work behind the provider port / edge)

Real gateway backends (Kong/Envoy/NGINX/cloud), an actual HTTP transport binding, and
streaming/websocket routing are declared extension points, not implemented in this phase.
The memory provider + cache are single-process.
