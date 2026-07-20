'use strict';

/**
 * SDK ↔ Storage adapter (Phase 14.3.4 §8/§9). Gives an Extension a granted,
 * namespace-isolated Storage port WITHOUT leaking provider internals. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`storage.ext.<owner>`); an extension cannot read/write another's.
 *   • Ownership — the owner is fixed; namespace cannot be overridden by the caller.
 *   • Permission — writes require the `storage:write` capability; reads require
 *     `storage:read`. Missing capability → PermissionError.
 *   • Optimistic locking — `expectedVersion` passes straight through.
 * Provider management (useProvider) and raw internals are never exposed.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toStoragePort(
  storage,
  { owner, canRead = true, canWrite = true, namespacePrefix = 'storage.ext.' } = {}
) {
  if (!owner) throw new Error('toStoragePort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead) throw new PermissionError(`extension "${owner}" lacks capability "storage:read"`);
  };
  const requireWrite = () => {
    if (!canWrite)
      throw new PermissionError(`extension "${owner}" lacks capability "storage:write"`);
  };
  const scoped = (spec = {}) => ({ ...spec, namespace }); // force the owner's namespace

  return {
    get(spec) {
      requireRead();
      return storage.get(scoped(spec));
    },
    exists(spec) {
      requireRead();
      return storage.exists(scoped(spec));
    },
    list(spec) {
      requireRead();
      return storage.list(scoped(spec));
    },
    query(spec) {
      requireRead();
      return storage.query(scoped(spec));
    },
    put(spec) {
      requireWrite();
      return storage.put(scoped(spec));
    },
    update(spec) {
      requireWrite();
      return storage.update(scoped(spec));
    },
    delete(spec) {
      requireWrite();
      return storage.delete(scoped(spec));
    },
    transaction(fn) {
      requireWrite();
      // Wrap the tx so every op is forced into the owner's namespace too.
      return storage.transaction((tx) => {
        const wrap = (m) => (spec) => tx[m](scoped(spec));
        return fn({
          get: wrap('get'),
          put: wrap('put'),
          update: wrap('update'),
          delete: wrap('delete'),
        });
      });
    },
    batch(ops = []) {
      requireWrite();
      return storage.batch(ops.map((o) => ({ ...o, namespace })));
    },
    health() {
      requireRead();
      return storage.health();
    },
  };
}

module.exports = { toStoragePort };
