'use strict';

/**
 * Policy PORT (Phase 14.6 / ADR-025 §1) — the platform-wide decision abstraction
 * every Kernel Service and Extension depends on. Consumers see only this
 * contract, never the provider or engine internals:
 *
 *   register(spec)          register/update a policy definition
 *   evaluate(request, opts) → { allowed, decision, reason, decidingPolicy }
 *   explain(request, opts)  → evaluate + full per-policy trace (uncached)
 *   enable(ns, policyId) / disable(ns, policyId)
 *   list(spec) / health()
 *
 * `request` is `{ namespace?, scope, ...context }`; conditions resolve fields
 * against the context (dotted paths). Default decision is DENY.
 */

const METHODS = Object.freeze([
  'register',
  'evaluate',
  'explain',
  'enable',
  'disable',
  'list',
  'health',
]);

function assertPolicy(p) {
  if (!p || typeof p !== 'object') throw new Error('Policy: adapter required');
  for (const m of METHODS) {
    if (typeof p[m] !== 'function') throw new Error(`Policy: adapter must implement ${m}()`);
  }
  return p;
}

module.exports = { assertPolicy, METHODS };
