'use strict';

/**
 * MultiTenancyProvider PORT (Phase 15.9 / ADR-038 §4) — persistence ONLY. Providers
 * store TENANT definitions; they never resolve, build context, evaluate capability,
 * manage lifecycle, or emit events — all tenant behavior lives in the engine, so
 * engine behavior is identical regardless of provider. NOT Kubernetes/IAM/DB
 * multi-tenancy — PostgreSQL/Storage/Redis/MongoDB/cloud registries are declared
 * extension points behind this contract.
 *
 * Contract (all async unless noted):
 *   name
 *   putTenant(namespace, model) → void
 *   getTenant(namespace, tenantId) → model | null
 *   getTenantByName(namespace, tenantName) → model | null
 *   listTenants(namespace) → model[]
 *   removeTenant(namespace, tenantId) → boolean
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze([
  'putTenant',
  'getTenant',
  'getTenantByName',
  'listTenants',
  'removeTenant',
  'health',
]);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('MultiTenancyProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`MultiTenancyProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze([
  'postgresql',
  'storage', // Enterprise Storage Platform (ADR-021)
  'redis',
  'mongodb',
  'cloud-registry',
  'custom',
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`tenancy: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `tenancy provider "${name}" is an extension point — not implemented in Phase 15.9`
    );
  };
  return {
    name,
    planned: true,
    putTenant: notImpl,
    getTenant: notImpl,
    getTenantByName: notImpl,
    listTenants: () => [],
    removeTenant: () => false,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
