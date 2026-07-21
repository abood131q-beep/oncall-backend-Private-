'use strict';

/**
 * Compatibility PORT (Phase 15.12 / ADR-041 §1) — the abstraction contract the platform
 * (and the SDK adapter) depend on, so callers never bind to the concrete engine. Exposes
 * ONLY the six kernel operations.
 *
 *   registerContract(spec, opts) → public contract model
 *   evaluate(request, opts)      → deterministic compatibility decision
 *   negotiate(request, opts)     → capability negotiation + version resolution result
 *   deprecate(request, opts)     → deprecated/retired contract model
 *   verify(request, opts)        → { ok, ... } (checksum integrity + compatibility)
 *   health()                     → { ok, ... }
 */

const METHODS = Object.freeze([
  'registerContract',
  'evaluate',
  'negotiate',
  'deprecate',
  'verify',
  'health',
]);

function assertCompatibility(s) {
  if (!s) throw new Error('CompatibilityPort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`CompatibilityPort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertCompatibility, METHODS };
