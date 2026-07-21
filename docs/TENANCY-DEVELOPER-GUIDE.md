# Enterprise Multi-Tenancy Kernel — Developer Guide (ADR-038)

The Multi-Tenancy Kernel is the platform's unified abstraction for deterministic tenant
isolation, tenant context propagation, tenant-scoped policies, and tenant lifecycle
orchestration. It is **not Kubernetes namespaces / database schemas / IAM / organization
management** — those are infrastructure concerns. It lives under `tenancy/`, additive to
every existing kernel.

## 1. Compose

```js
const { createTenancyPlatform } = require('../../src/application/tenancy');
const tk = createTenancyPlatform({
  publisher, // EventPublisher port (ADR-016)
  defaults: { capabilities: ['base'], labels: { plan: 'standard' }, configRef: 'cfg-default' },
});
const T = tk.tenancy;
```

## 2. Register a tenant

```js
const tenant = await T.registerTenant({
  tenantName: 'acme', // unique per namespace
  isolationLevel: 'strict', // strict | shared | dedicated
  configRef: 'cfg-acme', // Configuration reference (inherited)
  policyRef: 'pol-acme', // Policy reference (inherited)
  ownerRef: 'user-42', // Owner reference
  capabilities: ['premium'],
  labels: { region: 'us-east' },
  metadata: { billing: 'net30' },
});
// → tenantStatus: 'pending'
```

## 3. Lifecycle

```js
await T.activateTenant({ tenantId: tenant.tenantId }); // → 'active'; TenantActivated
await T.deactivateTenant({ tenantId: tenant.tenantId }); // → 'inactive'; TenantDeactivated
```

## 4. Resolve the tenant context

```js
const ctx = await T.resolveTenant({ tenantId }); // or { tenantName }
// → frozen context:
// { tenantId, namespace, tenantName, status, active, isolationLevel, ownerRef,
//   configRef, policyRef, capabilities, labels, metadata, resolvedAt }
```

Resolution is deterministic and **cached by tenant checksum** — a lifecycle/definition
change bumps the checksum and invalidates the cache. The context applies **inheritance**:
platform `defaults` merged beneath the tenant's own capabilities/labels/config/policy.

## 5. Verify + health

```js
await T.verify({ namespace }); // → { ok, issues } — tenant checksum integrity
await T.health();
```

## 6. Events (through the port only)

`TenantRegistered`, `TenantActivated`, `TenantDeactivated`, `TenantResolved`,
`TenantUpdated`, `TenantVerified` — all via the Event Backbone, producer `tenancy`.

## 7. Observability

```js
tk.metrics.snapshot(); // registered + active tenants (gauges), resolutions, activations,
// deactivations, verification runs, cacheHits/Misses, crossTenantBlocks, providerFailures,
// resolution latency, uptime
tk.metrics.prometheus();
```

## 8. SDK integration (ADR-018)

```js
const { toTenancyPort } = require('../../src/application/tenancy/sdkAdapter');
const portFactories = {
  'tenant:read': () => toTenancyPort(tk.tenancy, { owner: extId, tenantId: extTenant }),
  'tenant:manage': () => toTenancyPort(tk.tenancy, { owner: extId, tenantId: extTenant, canManage: true }),
};
// Inside the extension: this.tenancy().resolveTenant({})  // resolves the extension's own tenant
```

Every call is forced into the extension's namespace (`ext.<owner>`). `resolveTenant`/
`verify`/`list` require `tenant:read`; `registerTenant`/`activate`/`deactivate` require
`tenant:manage`. When the adapter is bound to a `tenantId`, requesting **any other tenant**
throws `CrossTenantError` — cross-tenant access is prevented at the SDK boundary.

## Isolation, inheritance & integrity

- **Namespace isolation** — tenants are stored and resolved per namespace; a tenant in one
  namespace is not resolvable from another.
- **Cross-tenant prevention** — a tenant-scoped SDK port can only touch its own tenant.
- **Inheritance** — capabilities are a union of defaults + tenant; labels/config/policy are
  tenant-overrides-default; the resolved context reflects the merge.
- **Integrity** — every tenant carries a checksum (including status); `resolveTenant`/
  `verify` detect tampering.

## Out of scope (future work behind the provider port)

Real tenant registries (PostgreSQL/Storage/Redis/MongoDB/cloud), hierarchical parent-tenant
inheritance, and per-tenant quota provisioning are declared extension points, not
implemented in this phase. The memory provider is single-process.
