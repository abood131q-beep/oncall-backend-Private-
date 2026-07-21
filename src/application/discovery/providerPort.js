'use strict';

/**
 * ServiceDiscoveryProvider PORT (Phase 15.5 / ADR-034 §4) — persistence ONLY.
 * Providers STORE service definitions; they never match, order, select, health-
 * check, or emit events — all discovery behavior lives in the engine, so engine
 * behavior is identical regardless of provider. NOT Consul/etcd/Kubernetes/DNS —
 * those (and cloud registries) are declared extension points behind this contract.
 *
 * Contract (all async unless noted):
 *   name
 *   putService(namespace, model) → void
 *   getService(namespace, serviceId) → model | null
 *   listServices(namespace) → model[]
 *   removeService(namespace, serviceId) → boolean
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze([
  'putService',
  'getService',
  'listServices',
  'removeService',
  'health',
]);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('ServiceDiscoveryProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`ServiceDiscoveryProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze([
  'consul',
  'etcd',
  'kubernetes',
  'dns',
  'cloud-registry',
  'custom',
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`discovery: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `discovery provider "${name}" is an extension point — not implemented in Phase 15.5`
    );
  };
  return {
    name,
    planned: true,
    putService: notImpl,
    getService: notImpl,
    listServices: () => [],
    removeService: () => false,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
