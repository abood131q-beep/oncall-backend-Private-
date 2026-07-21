'use strict';

/**
 * Service Mesh PORT (Phase 15.8 / ADR-037 §1) — the abstraction contract the
 * platform (and the SDK adapter) depend on, so callers never bind to the concrete
 * engine. Exposes ONLY the six kernel operations.
 *
 *   registerPolicy(spec, opts) → public connection model (registered)
 *   connect(spec, opts)        → public connection model (established)
 *   invoke(spec, opts)         → { ok, result, route, ... } (the protected invocation)
 *   disconnect(spec, opts)     → boolean
 *   verify(opts)               → { ok, issues } (connection integrity)
 *   health()                   → { ok, ... }
 */

const METHODS = Object.freeze([
  'registerPolicy',
  'connect',
  'invoke',
  'disconnect',
  'verify',
  'health',
]);

function assertMesh(s) {
  if (!s) throw new Error('MeshPort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`MeshPort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertMesh, METHODS };
