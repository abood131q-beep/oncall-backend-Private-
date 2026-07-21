'use strict';

/**
 * Jobs PORT (Phase 15.3 / ADR-032 §1) — the abstraction contract the platform (and
 * the SDK adapter) depend on, so callers never bind to the concrete engine. Exposes
 * ONLY the seven kernel operations.
 *
 *   register(spec)        → handler descriptor
 *   enqueue(spec, opts)   → job model (queued)
 *   schedule(spec, opts)  → job model (scheduled)
 *   cancel(spec, opts)    → boolean
 *   status(spec, opts)    → job model | null
 *   verify(opts)          → { ok, issues } (job integrity)
 *   health()              → { ok, ... }
 */

const METHODS = Object.freeze([
  'register',
  'enqueue',
  'schedule',
  'cancel',
  'status',
  'verify',
  'health',
]);

function assertJobs(s) {
  if (!s) throw new Error('JobsPort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`JobsPort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertJobs, METHODS };
