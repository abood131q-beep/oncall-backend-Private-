'use strict';

/**
 * SDK ↔ Resource Management adapter (Phase 15.10 / ADR-039 §7/§9). Gives an
 * Extension a granted, namespace-isolated Resource port WITHOUT leaking engine
 * internals or the ability to author resources. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`); it can only allocate/query within its own namespace.
 *   • Ownership — the namespace is forced; and allocations are stamped with the
 *     extension owner unless one is supplied.
 *   • Permission — allocate/release require `resource:allocate`; query/verify/list
 *     require `resource:read`. Missing capability → PermissionError.
 *   • Resource authoring (registerResource) is NOT exposed — declaring capacity is
 *     administrative.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toResourcePort(
  resources,
  { owner, canRead = true, canAllocate = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toResourcePort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead)
      throw new PermissionError(`extension "${owner}" lacks capability "resource:read"`);
  };
  const requireAllocate = () => {
    if (!canAllocate) {
      throw new PermissionError(`extension "${owner}" lacks capability "resource:allocate"`);
    }
  };

  return {
    allocate(spec = {}) {
      requireAllocate();
      return resources.allocate({ owner, ...spec }, { namespace });
    },
    release(spec = {}) {
      requireAllocate();
      return resources.release(spec, { namespace });
    },
    query(spec = {}) {
      requireRead();
      return resources.query(spec, { namespace });
    },
    verify() {
      requireRead();
      return resources.verify({ namespace });
    },
    list() {
      requireRead();
      return resources.list({ namespace });
    },
    health() {
      return resources.health();
    },
  };
}

module.exports = { toResourcePort };
