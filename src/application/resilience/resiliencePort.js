'use strict';

/**
 * Resilience PORT (Phase 15.7 / ADR-036 §1) — the abstraction contract the platform
 * (and the SDK adapter) depend on, so callers never bind to the concrete engine.
 * Exposes ONLY the six kernel operations.
 *
 *   registerPolicy(spec, opts) → public policy model
 *   execute(spec, opts)        → { ok, result, ... } — the protected execution
 *   evaluate(spec, opts)       → circuit state + whether execution is allowed (dry run)
 *   reset(spec, opts)          → boolean (reset circuit state)
 *   verify(opts)               → { ok, issues } (policy integrity)
 *   health()                   → { ok, ... }
 */

const METHODS = Object.freeze([
  'registerPolicy',
  'execute',
  'evaluate',
  'reset',
  'verify',
  'health',
]);

function assertResilience(s) {
  if (!s) throw new Error('ResiliencePort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`ResiliencePort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertResilience, METHODS };
