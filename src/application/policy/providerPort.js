'use strict';

/**
 * PolicyProvider PORT (Phase 14.6 / ADR-025 §4) — a policy-DEFINITION store. The
 * provider persists policy definitions ONLY; all evaluation logic remains in the
 * engine (a provider never decides). Business logic never knows which provider
 * is active. NOT tied to OPA/Cedar/Casbin.
 *
 * Contract:
 *   name
 *   put(namespace, policyModel) → void
 *   get(namespace, policyId) → policyModel | null
 *   remove(namespace, policyId) → boolean
 *   list(namespace) → policyModel[]
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze(['put', 'get', 'remove', 'list', 'health']);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('PolicyProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`PolicyProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze(['opa', 'cedar', 'casbin', 'custom']);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`policy: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `policy provider "${name}" is an extension point — not implemented in Phase 14.6`
    );
  };
  return {
    name,
    planned: true,
    put: notImpl,
    get: notImpl,
    remove: () => false,
    list: () => [],
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
