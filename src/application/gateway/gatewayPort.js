'use strict';

/**
 * API Gateway PORT (Phase 15.6 / ADR-035 §1) — the abstraction contract the platform
 * (and the SDK adapter) depend on, so callers never bind to the concrete engine.
 * Exposes ONLY the six kernel operations.
 *
 *   registerRoute(spec, opts) → public route model
 *   resolve(spec, opts)       → matched route + params + explanation
 *   dispatch(spec, opts)      → dispatch result (target + context + middleware trace)
 *   listRoutes(opts)          → public route model[]
 *   verify(opts)              → { ok, issues } (route + middleware integrity)
 *   health()                  → { ok, ... }
 */

const METHODS = Object.freeze([
  'registerRoute',
  'resolve',
  'dispatch',
  'listRoutes',
  'verify',
  'health',
]);

function assertGateway(s) {
  if (!s) throw new Error('GatewayPort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`GatewayPort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertGateway, METHODS };
