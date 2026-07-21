'use strict';

/**
 * Rate Limiting PORT (Phase 15.2 / ADR-031 §1) — the abstraction contract the
 * platform (and the SDK adapter) depend on, so callers never bind to the concrete
 * engine. Exposes ONLY the six kernel operations.
 *
 *   registerPolicy(spec, opts) → public policy model
 *   evaluate(spec, opts)       → { allowed, remaining, ... } (dry-run, no mutation)
 *   consume(spec, opts)        → { allowed, remaining, ... } (mutates the counter)
 *   reset(spec, opts)          → boolean
 *   verify(opts)               → { ok, issues } (policy integrity)
 *   health()                   → { ok, ... }
 */

const METHODS = Object.freeze([
  'registerPolicy',
  'evaluate',
  'consume',
  'reset',
  'verify',
  'health',
]);

function assertRateLimit(s) {
  if (!s) throw new Error('RateLimitPort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`RateLimitPort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertRateLimit, METHODS };
