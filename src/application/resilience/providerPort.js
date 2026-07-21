'use strict';

/**
 * ResilienceProvider PORT (Phase 15.7 / ADR-036 §4) — persistence ONLY. Providers
 * store resilience POLICIES and execution/circuit STATE; they never execute,
 * retry, time out, trip circuits, or emit events — all resilience behavior lives in
 * the engine, so engine behavior is identical regardless of provider. NOT Hystrix/
 * Resilience4j/Polly — Redis/PostgreSQL/Storage/MongoDB are declared extension points.
 *
 * Contract (all async unless noted):
 *   name
 *   putPolicy(namespace, model) → void
 *   getPolicy(namespace, policyId) → model | null
 *   listPolicies(namespace) → model[]
 *   removePolicy(namespace, policyId) → boolean
 *   getState(namespace, key) → state | null
 *   putState(namespace, key, state) → void
 *   resetState(namespace, key) → boolean
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze([
  'putPolicy',
  'getPolicy',
  'listPolicies',
  'removePolicy',
  'getState',
  'putState',
  'resetState',
  'health',
]);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('ResilienceProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`ResilienceProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze(['redis', 'postgresql', 'storage', 'mongodb', 'custom']);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`resilience: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `resilience provider "${name}" is an extension point — not implemented in Phase 15.7`
    );
  };
  return {
    name,
    planned: true,
    putPolicy: notImpl,
    getPolicy: notImpl,
    listPolicies: () => [],
    removePolicy: () => false,
    getState: notImpl,
    putState: notImpl,
    resetState: () => false,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
