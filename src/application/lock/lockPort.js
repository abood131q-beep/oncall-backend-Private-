'use strict';

/**
 * Lock PORT (Phase 14.3.5 §1) — the platform-wide locking abstraction every
 * Platform Service and Extension depends on. Consumers see only this contract,
 * never the provider or engine internals:
 *
 *   acquire(spec)     block (bounded) until held, or throw LockConflictError
 *   tryAcquire(spec)  one attempt; returns the lock model or null on conflict
 *   renew(spec)       extend the lease (owner only)
 *   release(spec)     release the lease (owner only)
 *   isHeld(spec)      is there a live lease?
 *   owner(spec)       current live owner id or null
 *   health()          provider + metrics health
 *
 * `spec` is `{ namespace, lockId, ownerId, leaseMs?, metadata?, waitMs? }`.
 */

const METHODS = Object.freeze([
  'acquire',
  'tryAcquire',
  'renew',
  'release',
  'isHeld',
  'owner',
  'health',
]);

function assertLock(l) {
  if (!l || typeof l !== 'object') throw new Error('Lock: adapter required');
  for (const m of METHODS) {
    if (typeof l[m] !== 'function') throw new Error(`Lock: adapter must implement ${m}()`);
  }
  return l;
}

module.exports = { assertLock, METHODS };
