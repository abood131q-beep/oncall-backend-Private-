'use strict';

/**
 * Identity PORT (Phase 14.8 / ADR-027 §1) — the platform-wide identity
 * abstraction every Kernel Service and Extension depends on. Consumers see only
 * this contract, never the provider or engine internals:
 *
 *   register(spec, opts)       create an identity → public model (no credentials)
 *   authenticate(spec, opts)   verify credentials → { session, context }
 *   refresh(spec, opts)        extend a live session (token-validated)
 *   revoke(spec, opts)         revoke a session
 *   resolve(spec, opts)        deterministic authorization context (by session or principal)
 *   health()                   provider + metrics health
 *
 * `spec` for authenticate: `{ namespace?, principal, credentials: { secret }, ttlMs? }`.
 */

const METHODS = Object.freeze([
  'register',
  'authenticate',
  'refresh',
  'revoke',
  'resolve',
  'health',
]);

function assertIdentity(i) {
  if (!i || typeof i !== 'object') throw new Error('Identity: adapter required');
  for (const m of METHODS) {
    if (typeof i[m] !== 'function') throw new Error(`Identity: adapter must implement ${m}()`);
  }
  return i;
}

module.exports = { assertIdentity, METHODS };
