'use strict';

/**
 * ResourceProvider PORT (Phase 15.10 / ADR-039 §4) — persistence ONLY. Providers
 * store RESOURCE definitions and ALLOCATION state; they never allocate, enforce
 * quota, preempt, or emit events — all allocation + governance behavior lives in the
 * engine, so engine behavior is identical regardless of provider. NOT Kubernetes
 * ResourceQuota / cgroups / Docker — PostgreSQL/Storage/Redis/MongoDB/cloud
 * registries are declared extension points behind this contract.
 *
 * Contract (all async unless noted):
 *   name
 *   putResource(namespace, model) → void
 *   getResource(namespace, resourceId) → model | null
 *   listResources(namespace) → model[]
 *   removeResource(namespace, resourceId) → boolean
 *   putAllocation(namespace, model) → void
 *   getAllocation(namespace, allocationId) → model | null
 *   listAllocations(namespace) → model[]
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze([
  'putResource',
  'getResource',
  'listResources',
  'removeResource',
  'putAllocation',
  'getAllocation',
  'listAllocations',
  'health',
]);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('ResourceProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`ResourceProvider: adapter must implement ${m}()`);
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
    throw new Error(`resources: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `resource provider "${name}" is an extension point — not implemented in Phase 15.10`
    );
  };
  return {
    name,
    planned: true,
    putResource: notImpl,
    getResource: notImpl,
    listResources: () => [],
    removeResource: () => false,
    putAllocation: notImpl,
    getAllocation: notImpl,
    listAllocations: () => [],
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
