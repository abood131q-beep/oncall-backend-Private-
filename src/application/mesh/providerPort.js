'use strict';

/**
 * ServiceMeshProvider PORT (Phase 15.8 / ADR-037 §4) — persistence ONLY. Providers
 * store CONNECTION definitions; they never invoke, route, evaluate policy, or emit
 * events — all mesh behavior lives in the engine, so engine behavior is identical
 * regardless of provider. NOT Istio/Linkerd/Consul Connect — those (and cloud
 * meshes) are declared extension points behind this contract.
 *
 * Contract (all async unless noted):
 *   name
 *   putConnection(namespace, model) → void
 *   getConnection(namespace, connectionId) → model | null
 *   listConnections(namespace) → model[]
 *   removeConnection(namespace, connectionId) → boolean
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze([
  'putConnection',
  'getConnection',
  'listConnections',
  'removeConnection',
  'health',
]);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('ServiceMeshProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`ServiceMeshProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze([
  'istio',
  'linkerd',
  'consul-connect',
  'cloud-mesh',
  'custom',
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`mesh: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `mesh provider "${name}" is an extension point — not implemented in Phase 15.8`
    );
  };
  return {
    name,
    planned: true,
    putConnection: notImpl,
    getConnection: notImpl,
    listConnections: () => [],
    removeConnection: () => false,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
