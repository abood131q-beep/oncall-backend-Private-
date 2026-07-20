'use strict';

/**
 * StorageProvider PORT (Phase 14.3.4 §4) — the low-level persistence contract the
 * Storage Kernel depends on. Business logic NEVER knows which provider is active;
 * it depends only on the Storage service, which depends only on this port.
 * Providers are dumb byte/record stores — no versioning logic, no events, no
 * business rules (those live in the service/domain).
 *
 * Contract (all async):
 *   name                                     string identifier
 *   read(namespace, key) → record | null
 *   write(namespace, key, record) → void
 *   remove(namespace, key) → boolean         (true if it existed)
 *   has(namespace, key) → boolean
 *   scan(namespace) → record[]               (all records in a namespace)
 *   writeBatch(ops) → void                   atomic apply of
 *                                            [{ op:'put'|'del', namespace, key, record? }]
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze(['read', 'write', 'remove', 'has', 'scan', 'writeBatch', 'health']);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('StorageProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function')
      throw new Error(`StorageProvider: adapter must implement ${m}()`);
  }
  return p;
}

/**
 * Extension points for FUTURE providers (§4). Declared, not implemented — the
 * kernel can register any later without business-logic changes.
 */
const FUTURE_PROVIDERS = Object.freeze([
  'sqlite',
  'postgres',
  'mysql',
  'mongodb',
  'redis',
  's3',
  'azure-blob',
  'google-cloud-storage',
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`storage: "${name}" is not a recognized future provider`);
  }
  const notImpl = () =>
    Promise.reject(
      new Error(
        `storage provider "${name}" is an extension point — not implemented in Phase 14.3.4`
      )
    );
  return {
    name,
    planned: true,
    read: notImpl,
    write: notImpl,
    remove: notImpl,
    has: notImpl,
    scan: notImpl,
    writeBatch: notImpl,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
