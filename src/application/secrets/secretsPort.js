'use strict';

/**
 * Secrets PORT (Phase 14.9 / ADR-028 §1) — the abstraction contract the platform
 * (and the SDK adapter) depend on, so callers never bind to the concrete engine.
 * Exposes ONLY the six kernel operations.
 *
 *   store(spec, opts)   → public secret model (value REDACTED)
 *   resolve(spec, opts) → { value, version, ... } (the ONLY value-revealing call)
 *   rotate(spec, opts)  → public secret model (new version, value REDACTED)
 *   delete(spec, opts)  → boolean
 *   list(opts)          → public secret model[]
 *   health()            → { ok, ... }
 */

const METHODS = Object.freeze(['store', 'resolve', 'rotate', 'delete', 'list', 'health']);

function assertSecrets(s) {
  if (!s) throw new Error('SecretsPort: implementation required');
  for (const m of METHODS) {
    if (typeof s[m] !== 'function') throw new Error(`SecretsPort: must implement ${m}()`);
  }
  return s;
}

module.exports = { assertSecrets, METHODS };
