'use strict';

/**
 * Feature Flag PORT (Phase 15.0 / ADR-029 §1) — the abstraction contract the
 * platform (and the SDK adapter) depend on, so callers never bind to the concrete
 * engine. Exposes ONLY the eight kernel operations.
 *
 *   register(spec, opts)  → public flag model
 *   evaluate(spec, opts)  → { value, reason, served, ... } (deterministic + explained)
 *   enable(spec, opts)    → public flag model
 *   disable(spec, opts)   → public flag model
 *   update(spec, opts)    → public flag model (new version)
 *   list(opts)            → public flag model[]
 *   verify(opts)          → { ok, issues } (definition integrity)
 *   health()              → { ok, ... }
 */

const METHODS = Object.freeze([
  'register',
  'evaluate',
  'enable',
  'disable',
  'update',
  'list',
  'verify',
  'health',
]);

function assertFeatures(s) {
  if (!s) throw new Error('FeaturesPort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`FeaturesPort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertFeatures, METHODS };
