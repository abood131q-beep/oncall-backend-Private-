'use strict';

/**
 * SDK ↔ Lock adapter (Phase 14.3.5 §8/§9). Gives an Extension a granted,
 * owner-scoped, namespace-isolated Lock port WITHOUT leaking provider internals.
 * Security:
 *   • Ownership — `ownerId` is forced to the extension id; an extension cannot
 *     acquire/renew/release under another identity.
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`lock.ext.<owner>`); it cannot touch another extension's locks.
 *   • Permission — write ops (acquire/tryAcquire/renew/release) require the
 *     `lock:write` capability; read ops (isHeld/owner/health) require `lock:read`.
 *     Missing capability → PermissionError.
 * Provider management (useProvider) and raw internals are never exposed.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toLockPort(
  lock,
  { owner, canRead = true, canWrite = true, namespacePrefix = 'lock.ext.' } = {}
) {
  if (!owner) throw new Error('toLockPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead) throw new PermissionError(`extension "${owner}" lacks capability "lock:read"`);
  };
  const requireWrite = () => {
    if (!canWrite) throw new PermissionError(`extension "${owner}" lacks capability "lock:write"`);
  };
  // Force the owner's namespace AND identity; callers cannot override either.
  const scoped = (spec = {}) => ({ ...spec, namespace, ownerId: owner });
  const scopedRead = (spec = {}) => ({ ...spec, namespace });

  return {
    acquire(spec) {
      requireWrite();
      return lock.acquire(scoped(spec));
    },
    tryAcquire(spec) {
      requireWrite();
      return lock.tryAcquire(scoped(spec));
    },
    renew(spec) {
      requireWrite();
      return lock.renew(scoped(spec));
    },
    release(spec) {
      requireWrite();
      return lock.release(scoped(spec));
    },
    isHeld(spec) {
      requireRead();
      return lock.isHeld(scopedRead(spec));
    },
    owner(spec) {
      requireRead();
      return lock.owner(scopedRead(spec));
    },
    health() {
      requireRead();
      return lock.health();
    },
  };
}

module.exports = { toLockPort };
