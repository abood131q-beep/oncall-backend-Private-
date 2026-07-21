'use strict';

/**
 * Resource Management PORT (Phase 15.10 / ADR-039 §1) — the abstraction contract the
 * platform (and the SDK adapter) depend on, so callers never bind to the concrete
 * engine. Exposes ONLY the six kernel operations.
 *
 *   registerResource(spec, opts) → public resource model
 *   allocate(spec, opts)         → allocation record (+ resource accounting)
 *   release(spec, opts)          → boolean
 *   query(spec, opts)            → resource accounting (capacity/allocated/available/...)
 *   verify(opts)                 → { ok, issues } (resource + accounting integrity)
 *   health()                     → { ok, ... }
 */

const METHODS = Object.freeze([
  'registerResource',
  'allocate',
  'release',
  'query',
  'verify',
  'health',
]);

function assertResources(s) {
  if (!s) throw new Error('ResourcesPort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`ResourcesPort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertResources, METHODS };
