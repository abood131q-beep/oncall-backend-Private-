'use strict';

/**
 * CompatibilityProvider PORT (Phase 15.12 / ADR-041 §4) — persistence ONLY. Providers
 * store compatibility METADATA (contract definitions keyed by namespace); they never
 * evaluate compatibility, negotiate capabilities, resolve versions, enforce deprecation,
 * or emit events — ALL compatibility behavior lives in the engine, so engine behavior is
 * identical regardless of provider. NOT semver/npm/API-versioning middleware/a migration
 * framework — PostgreSQL/Storage/Redis/MongoDB/cloud registries are declared extension
 * points.
 *
 * Contract (all async unless noted):
 *   name
 *   putContract(namespace, model) → void
 *   getContract(namespace, contractId) → model | null
 *   listContracts(namespace) → model[]
 *   removeContract(namespace, contractId) → boolean
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze([
  'putContract',
  'getContract',
  'listContracts',
  'removeContract',
  'health',
]);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('CompatibilityProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`CompatibilityProvider: adapter must implement ${m}()`);
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
    throw new Error(`compatibility: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `compatibility provider "${name}" is an extension point — not implemented in Phase 15.12`
    );
  };
  return {
    name,
    planned: true,
    putContract: notImpl,
    getContract: notImpl,
    listContracts: () => [],
    removeContract: () => false,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
