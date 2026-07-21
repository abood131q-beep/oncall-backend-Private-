'use strict';

/**
 * ApiGatewayProvider PORT (Phase 15.6 / ADR-035 §4) — persistence ONLY. Providers
 * store ROUTE definitions; they never match, dispatch, run middleware, enforce
 * policy, or emit events — all gateway behavior lives in the engine, so engine
 * behavior is identical regardless of provider. NOT Kong/Envoy/NGINX — those (and
 * cloud API gateways) are declared extension points behind this contract.
 *
 * Contract (all async unless noted):
 *   name
 *   putRoute(namespace, model) → void
 *   getRoute(namespace, routeId) → model | null
 *   listRoutes(namespace) → model[]
 *   removeRoute(namespace, routeId) → boolean
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze(['putRoute', 'getRoute', 'listRoutes', 'removeRoute', 'health']);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('ApiGatewayProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`ApiGatewayProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze(['kong', 'envoy', 'nginx', 'cloud-gateway', 'custom']);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`gateway: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `gateway provider "${name}" is an extension point — not implemented in Phase 15.6`
    );
  };
  return {
    name,
    planned: true,
    putRoute: notImpl,
    getRoute: notImpl,
    listRoutes: () => [],
    removeRoute: () => false,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
