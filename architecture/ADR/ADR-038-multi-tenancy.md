# ADR-038 — Enterprise Multi-Tenancy Kernel

**Status:** Accepted · **Owner:** Chief Software Architect · **Date:** 2026-07-21
**Phase:** 15.9 · **Depends on:** ADR-016 (Event Backbone), ADR-018 (Extension SDK),
ADR-019 (Configuration), ADR-025 (Policy), ADR-026 (Audit), ADR-027 (Identity), ADR-028
(Secrets) — integrated through their existing ports.

## Context

The platform needs one deterministic way to isolate tenants, resolve and propagate a
tenant context, apply tenant-scoped configuration/policy, and orchestrate the tenant
lifecycle — independent of any infrastructure tenancy mechanism. This is the Multi-Tenancy
Kernel. It is **not Kubernetes namespaces**, **not database schemas**, **not IAM**, and
**not organization management** — those are infrastructure/product concerns; this kernel is
the deterministic control-plane abstraction other kernels consume.

Tenant logic must never be embedded in application services (each re-deriving the tenant
from a header). Instead it is a Kernel Service behind a narrow port, so every service
resolves the same tenant context and cross-tenant access is prevented in one place.

To stay strictly additive, the kernel lives under `tenancy/` (new directories); no existing
kernel or application bounded context is touched. (Existing kernels already carry a
`tenant` field in their contexts; this kernel governs those tenants — it does not modify
them.)

## Decision

Add an additive Multi-Tenancy Kernel. Nothing in it is on a hot path, so the platform runs
byte-identically whether or not it is instantiated.

**Domain (pure):**

- `tenant.js` — the Tenant value object (tenantId, namespace, tenantName, tenantStatus,
  isolationLevel, configRef, policyRef, ownerRef, metadata, labels, capabilities, version,
  `checksum`, createdAt, updatedAt) with `activate`/`deactivate`/`applyUpdate`. The checksum
  covers the whole definition including status, so a lifecycle change bumps it (and
  auto-invalidates cached contexts).
- `context.js` — the deterministic, frozen tenant context builder with configuration +
  policy + capability INHERITANCE (platform defaults merged beneath tenant values) and a
  `hasCapability` evaluator.
- `errors.js` — `TenancyError`, `TenancyValidationError`, `TenantNotFoundError`,
  `CrossTenantError`, `IntegrityError`.
- `events.js` — the event catalog (TenantRegistered, TenantActivated, TenantDeactivated,
  TenantResolved, TenantUpdated, TenantVerified); producer `tenancy`.

**Application (ports & adapters):**

- `providerPort.js` — the persistence contract (putTenant / getTenant / getTenantByName /
  listTenants / removeTenant / health) + declared extension points (PostgreSQL, Storage,
  Redis, MongoDB, cloud registry, custom). Providers store definitions; the engine owns all
  behavior.
- `providers/memoryProvider.js` — the implemented in-process tenant store (by id + name).
- `cache.js` — the checksum-keyed context cache (invalidated on lifecycle change).
- `metrics.js` — registered + active tenants (gauges), resolutions, activations,
  deactivations, verification runs, provider failures, resolution latency, uptime;
  Prometheus.
- `tenancyPort.js` — the abstraction contract (`assertTenancy`): registerTenant,
  resolveTenant, activateTenant, deactivateTenant, verify, health.
- `tenancyService.js` — the kernel: deterministic tenant resolution, context propagation,
  namespace isolation, capability evaluation, lifecycle management, config/policy
  inheritance, tenant verification, and context caching. Tenant mutations are atomic via a
  serialization mutex.
- `sdkAdapter.js` — `toTenancyPort(tenancy, { owner, tenantId, canRead, canManage })`:
  namespace isolation + **cross-tenant access prevention** (a tenant-scoped adapter may only
  touch its own tenant) + `tenant:read` / `tenant:manage` enforcement.
- `index.js` — `createTenancyPlatform(deps)` composition root (accepts `defaults` for
  inheritance).

## Kernel integration

Per §5, the Multi-Tenancy Kernel integrates with other kernels **only through their existing
ports**: Identity (ADR-027) associates principals to tenants; Configuration (ADR-019) and
Policy (ADR-025) are referenced by `configRef`/`policyRef` and inherited into the context;
Secrets (ADR-028) scopes tenant secrets; the API Gateway (ADR-035) and Service Mesh
(ADR-037) propagate the resolved tenant context; the Event Backbone (EventPublisher) carries
lifecycle events; Audit (ADR-026) records them. It imports no implementation classes.

## Alternatives rejected

- **Kubernetes namespaces / IAM / DB schemas as the mechanism** — rejected: couples tenancy
  to infrastructure. Those remain provider/deployment concerns; this kernel is the
  deterministic control plane.
- **Deriving the tenant ad-hoc in each service** — rejected: duplicates isolation logic and
  risks cross-tenant leakage; resolution + prevention live in one kernel.
- **Provider-side resolution** — rejected: resolution, inheritance, capability evaluation,
  and integrity live in the engine so behavior is uniform regardless of provider.

## Consequences

- New files under `src/domain/tenancy/**` and `src/application/tenancy/**`, plus
  `tests/unit/tenancy.test.js` (+15 tests). Zero hot-path change; A/B byte-identical.
- Real tenant registries (Postgres/Storage/Redis/Mongo/cloud), hierarchical/parent-tenant
  inheritance, and per-tenant quota provisioning are future work behind the provider port.
  The memory provider is single-process.

## Rollback

Delete `src/domain/tenancy/`, `src/application/tenancy/`, and `tests/unit/tenancy.test.js`.
Nothing imports them at runtime, so removal is inert and every prior kernel (ADR-016 …
ADR-037) is unchanged. See `docs/TENANCY-ROLLBACK-PLAN.md`.
