'use strict';

/**
 * Observability PORT (Phase 15.4 / ADR-033 §1) — the abstraction contract the
 * platform (and the SDK adapter) depend on, so callers never bind to the concrete
 * engine. Exposes ONLY the six kernel operations.
 *
 *   register(spec, opts)    → component model
 *   collect(spec, opts)     → component model (report merged)
 *   snapshot(opts)          → aggregated snapshot
 *   diagnostics(opts)       → structured diagnostics (redacted)
 *   verify(opts)            → { ok, issues } (component/snapshot integrity)
 *   health()                → { ok, status, ... }
 */

const METHODS = Object.freeze([
  'register',
  'collect',
  'snapshot',
  'diagnostics',
  'verify',
  'health',
]);

function assertObservability(s) {
  if (!s) throw new Error('ObservabilityPort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`ObservabilityPort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertObservability, METHODS };
