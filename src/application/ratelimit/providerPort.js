'use strict';

/**
 * RateLimitProvider PORT (Phase 15.2 / ADR-031 §4) — persistence ONLY. Providers
 * store POLICY definitions and COUNTER state; they never evaluate, decay, decide
 * admission, or emit events — all rate-limiting behavior lives in the engine, so
 * engine behavior is identical regardless of provider. NOT Express Rate Limit /
 * NGINX / Redis middleware — Redis/Storage/PostgreSQL/MongoDB are declared
 * extension points behind this same contract.
 *
 * Contract (all async unless noted):
 *   name
 *   putPolicy(namespace, model) → void
 *   getPolicy(namespace, policyId) → model | null
 *   listPolicies(namespace) → model[]
 *   removePolicy(namespace, policyId) → boolean
 *   getCounter(namespace, key) → state | null
 *   putCounter(namespace, key, state) → void
 *   resetCounter(namespace, key) → boolean
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze([
  'putPolicy',
  'getPolicy',
  'listPolicies',
  'removePolicy',
  'getCounter',
  'putCounter',
  'resetCounter',
  'health',
]);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('RateLimitProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`RateLimitProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze([
  'redis',
  'storage', // Enterprise Storage Platform (ADR-021)
  'postgresql',
  'mongodb',
  'custom',
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`ratelimit: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `rate limit provider "${name}" is an extension point — not implemented in Phase 15.2`
    );
  };
  return {
    name,
    planned: true,
    putPolicy: notImpl,
    getPolicy: notImpl,
    listPolicies: () => [],
    removePolicy: () => false,
    getCounter: notImpl,
    putCounter: notImpl,
    resetCounter: () => false,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
