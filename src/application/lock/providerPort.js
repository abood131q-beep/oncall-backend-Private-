'use strict';

/**
 * LockProvider PORT (Phase 14.3.5 §4) — the low-level lock-store contract the Lock
 * Kernel depends on. Business logic NEVER knows which provider is active; it
 * depends only on the Lock service, which depends only on this port. Providers
 * are dumb record stores keyed by (namespace, lockId) — no lease logic, no
 * ownership rules, no events (those live in the service/domain).
 *
 * NOT distributed coordination: the memory provider is single-process. A future
 * Redis/etcd/ZooKeeper adapter can implement the same contract, but distributed
 * consensus is explicitly out of scope for this phase.
 *
 * Contract (all async):
 *   name                                    string id
 *   read(namespace, lockId) → lock | null
 *   write(namespace, lockId, lock) → void
 *   remove(namespace, lockId) → boolean
 *   scan(namespace) → lock[]
 *   health() → { ok, ... }
 */

const METHODS = Object.freeze(['read', 'write', 'remove', 'scan', 'health']);

function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || !p.name) {
    throw new Error('LockProvider: adapter must expose a name');
  }
  for (const m of METHODS) {
    if (typeof p[m] !== 'function') throw new Error(`LockProvider: adapter must implement ${m}()`);
  }
  return p;
}

/** Extension points for FUTURE providers (§4). Declared, not implemented. */
const FUTURE_PROVIDERS = Object.freeze([
  'redis',
  'postgres-advisory',
  'mysql',
  'zookeeper',
  'etcd',
  'consul',
]);

function futureProvider(name) {
  if (!FUTURE_PROVIDERS.includes(name)) {
    throw new Error(`lock: "${name}" is not a recognized future provider`);
  }
  const notImpl = () =>
    Promise.reject(
      new Error(`lock provider "${name}" is an extension point — not implemented in Phase 14.3.5`)
    );
  return {
    name,
    planned: true,
    read: notImpl,
    write: notImpl,
    remove: notImpl,
    scan: notImpl,
    health: () => ({ ok: false, reason: 'not-implemented' }),
  };
}

module.exports = { assertProvider, METHODS, FUTURE_PROVIDERS, futureProvider };
