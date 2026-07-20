'use strict';

/**
 * AuditProvider PORT (Phase 14.7 / ADR-026 §4) — an APPEND-ONLY record store.
 * The provider persists immutable audit records ONLY; it performs no integrity
 * verification and no query logic (the engine owns both). Business logic never
 * knows which provider is active. NOT application logging.
 *
 * Contract (append-only — no update, no delete):
 *   name
 *   append(namespace, record) → void
 *   scan(namespace) → record[]        (in append order)
 *   get(namespace, auditId) → record | null
 *   count(namespace) → number
 *   tail(namespace) → record | null   (most recent, for chain linkage)
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze(['append', 'scan', 'get', 'count', 'tail', 'health']);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('AuditProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function') throw new Error(`AuditProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze(['storage', 'postgres', 'mongodb', 'object-storage']);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`audit: "${name}" is not a recognized future provider`);
  }
  const notImpl = () => {
    throw new Error(
      `audit provider "${name}" is an extension point — not implemented in Phase 14.7`
    );
  };
  return {
    name,
    planned: true,
    append: notImpl,
    scan: notImpl,
    get: notImpl,
    count: () => 0,
    tail: () => null,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
