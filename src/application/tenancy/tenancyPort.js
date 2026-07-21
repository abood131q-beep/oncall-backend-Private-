'use strict';

/**
 * Multi-Tenancy PORT (Phase 15.9 / ADR-038 §1) — the abstraction contract the
 * platform (and the SDK adapter) depend on, so callers never bind to the concrete
 * engine. Exposes ONLY the six kernel operations.
 *
 *   registerTenant(spec, opts)   → public tenant model
 *   resolveTenant(spec, opts)    → deterministic tenant context (inherited + frozen)
 *   activateTenant(spec, opts)   → public tenant model (active)
 *   deactivateTenant(spec, opts) → public tenant model (inactive)
 *   verify(opts)                 → { ok, issues } (tenant integrity)
 *   health()                     → { ok, ... }
 */

const METHODS = Object.freeze([
  'registerTenant',
  'resolveTenant',
  'activateTenant',
  'deactivateTenant',
  'verify',
  'health',
]);

function assertTenancy(s) {
  if (!s) throw new Error('TenancyPort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`TenancyPort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertTenancy, METHODS };
