'use strict';

/**
 * Lifecycle Management PORT (Phase 15.11 / ADR-040 §1) — the abstraction contract the
 * platform (and the SDK adapter) depend on, so callers never bind to the concrete
 * engine. Exposes ONLY the eight kernel operations.
 *
 *   register(spec, opts)    → public component model
 *   initialize(spec, opts)  → initialized component(s) (dependency order)
 *   start(spec, opts)       → started component(s) (dependency-ordered startup)
 *   stop(spec, opts)        → stopped component(s) (reverse order, graceful)
 *   restart(spec, opts)     → restarted component model
 *   status(spec, opts)      → component model | null
 *   verify(opts)            → { ok, issues } (graph + checksum integrity)
 *   health()                → { ok, ... }
 */

const METHODS = Object.freeze([
  'register',
  'initialize',
  'start',
  'stop',
  'restart',
  'status',
  'verify',
  'health',
]);

function assertLifecycle(s) {
  if (!s) throw new Error('LifecyclePort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`LifecyclePort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertLifecycle, METHODS };
