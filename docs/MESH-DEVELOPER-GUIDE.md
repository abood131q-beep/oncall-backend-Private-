# Enterprise Service Mesh Kernel — Developer Guide (ADR-037)

The Service Mesh Kernel is the platform's unified abstraction for deterministic
service-to-service communication policies, traffic orchestration, secure invocation, and
mesh governance. It is **not Istio/Linkerd/Consul Connect** and **not a network proxy** —
those are provider extension points / a data plane. It lives under `mesh/`, additive to
every existing kernel.

## 1. Compose (with optional kernel ports)

```js
const { createMeshPlatform } = require('../../src/application/mesh');
const mk = createMeshPlatform({
  publisher, // EventPublisher port (ADR-016)
  ports: {
    // all optional — each step is skipped if its port is absent
    identity, // ADR-027: resolve({ token }) → { ok, context }
    policy, // ADR-025: evaluate({ context, action, resource }) → { effect }
    ratelimit, // ADR-031: consume({ policyId, subject }) → { allowed }
    discovery, // ADR-034: resolve({ serviceName, key }) → { selected: { endpoint } }
    resilience, // ADR-036: execute({ policyId, fn }) → { ok, result }
  },
});
const M = mk.mesh;
```

## 2. Register + connect

```js
const conn = await M.registerPolicy({
  sourceService: 'api-gateway',
  destinationService: 'trips',
  protocol: 'grpc',
  securityPolicy: { requireIdentity: true, allowedSources: ['api-gateway'], mtls: true },
  trafficPolicy: { maxConcurrent: 50, rateLimitPolicy: 'trips-rl' },
  routingPolicy: { strategy: 'subset', subset: 'v2' },
  retryPolicy: { resiliencePolicyId: 'trips-resilience' }, // delegates retries to Resilience
  timeout: 2000,
});
// → connectionState: 'registered'
await M.connect({ connectionId: conn.connectionId }); // → 'established'
```

## 3. Invoke over the connection

```js
const r = await M.invoke({
  connectionId: conn.connectionId,
  fn: async (ctx) => callTrips(ctx.endpoint, ctx.route), // ctx = secure invocation context
  token: '...', // for mutual identity
  sourceService: 'api-gateway', // checked against allowedSources
  subject: 'user-1', // rate-limit + discovery key
  secure: true, // asserts the transport is mTLS-secured
});
// → { ok: true, invocationId, connectionId, result, route, latencyMs }
```

`invoke` runs, in order: connection integrity → established check → identity propagation →
security admission (mutual identity + allowed sources) → policy enforcement → rate limiting
→ traffic-concurrency limit → destination resolution (service discovery) → retry delegation
(resilience) / timeout-bounded call → completion. A failed policy step throws
`MeshRejectedError` with a `reason` (`not_connected`, `identity_required`,
`source_not_allowed`, `mtls_required`, `policy_denied`, `rate_limited`, `traffic_limit`,
`destination_unavailable`) and emits `InvocationFailed`.

## 4. Disconnect + verify + health

```js
await M.disconnect({ connectionId }); // → true; ConnectionClosed
await M.verify({ namespace }); // → { ok, issues } — connection checksum integrity
await M.health();
```

## 5. Events (through the port only)

`ConnectionRegistered`, `ConnectionEstablished`, `InvocationStarted`, `InvocationCompleted`,
`InvocationFailed`, `ConnectionClosed`, `MeshVerified` — all via the Event Backbone,
producer `mesh`.

## 6. Observability

```js
mk.metrics.snapshot(); // registered + active connections (gauges), invocations,
// successful/failed invocations, policyViolations, providerFailures, connection latency, uptime
mk.metrics.prometheus();
```

## 7. SDK integration (ADR-018)

```js
const { toMeshPort } = require('../../src/application/mesh/sdkAdapter');
const portFactories = {
  'mesh:read': () => toMeshPort(mk.mesh, { owner: extId, canInvoke: false }),
  'mesh:invoke': () => toMeshPort(mk.mesh, { owner: extId }),
};
// Inside the extension: this.mesh().invoke({ connectionId, fn })
```

Every call is forced into the extension's namespace (`ext.<owner>`). `invoke` requires
`mesh:invoke`; `verify`/`list` require `mesh:read`. Connection authoring (registerPolicy,
connect, disconnect) is administrative and not exposed to extensions.

## Determinism, security & integration

- **Deterministic** — an injected clock drives timeout + latency; the same connection +
  context always yields the same admission + routing decision.
- **Mutual identity** — the security policy requires an authenticated identity and gates the
  source service against `allowedSources`; identity is resolved through the Identity port and
  propagated into the secure invocation context.
- **Integration through ports only** — identity/policy/rate-limit/discovery/resilience are
  injected kernel ports; the mesh calls only their public methods.
- **Integrity** — every connection carries a checksum; `invoke`/`verify` detect tampering.

## Out of scope (future work behind the provider port / edge)

Real mesh backends (Istio/Linkerd/Consul/cloud), an actual data-plane binding, and
streaming/bidirectional invocation are declared extension points, not implemented in this
phase. The memory provider is single-process.
