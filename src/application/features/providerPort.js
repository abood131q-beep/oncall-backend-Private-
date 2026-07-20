'use strict';

/**
 * FeatureFlagProvider PORT (Phase 15.0 / ADR-029 §4) — persistence ONLY. Providers
 * STORE flag definitions; they never evaluate, target, roll out, cache, or emit
 * events — all feature behavior lives in the evaluation engine, so engine behavior
 * is identical regardless of which provider is active. NOT LaunchDarkly/Unleash/
 * Firebase — those (and Storage/PostgreSQL/Redis/MongoDB/cloud config) are declared
 * extension points behind this same contract.
 *
 * Contract (all async unless noted):
 *   name
 *   putFlag(namespace, model) → void
 *   getFlag(namespace, name) → model | null
 *   listFlags(namespace) → model[]
 *   removeFlag(namespace, name) → boolean
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze(['putFlag', 'getFlag', 'listFlags', 'removeFlag', 'health']);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('FeatureFlagProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`FeatureFlagProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze([
  'storage', // Enterprise Storage Platform (ADR-021)
  'postgresql',
  'redis',
  'mongodb',
  'cloud-config', // Cloud config providers
  'custom',
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`features: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `feature flag provider "${name}" is an extension point — not implemented in Phase 15.0`
    );
  };
  return {
    name,
    planned: true,
    putFlag: notImpl,
    getFlag: notImpl,
    listFlags: () => [],
    removeFlag: () => false,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
