'use strict';

/**
 * SDK ↔ Audit adapter (Phase 14.7 / ADR-026 §8/§9). Gives an Extension a granted,
 * namespace-isolated Audit port WITHOUT leaking engine internals. Security:
 *   • Namespace isolation — every record/query/verify is forced into the
 *     extension's own namespace (`ext.<owner>`); it cannot read or write another
 *     extension's audit trail.
 *   • Ownership — the record's `actor` defaults to the owner and the namespace is
 *     forced; callers cannot override the namespace.
 *   • Immutability — records remain append-only; there is no update/delete path.
 *   • Permission — record requires `audit:write`; query/get/verify require
 *     `audit:read`. Missing capability → PermissionError.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toAuditPort(
  audit,
  { owner, canRead = true, canWrite = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toAuditPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead) throw new PermissionError(`extension "${owner}" lacks capability "audit:read"`);
  };
  const requireWrite = () => {
    if (!canWrite) throw new PermissionError(`extension "${owner}" lacks capability "audit:write"`);
  };

  return {
    record(spec = {}) {
      requireWrite();
      return audit.record({ actor: owner, ...spec }, { namespace });
    },
    query(spec = {}) {
      requireRead();
      return audit.query(spec, { namespace });
    },
    get(auditId) {
      requireRead();
      return audit.get(namespace, auditId);
    },
    verify() {
      requireRead();
      return audit.verify({ namespace });
    },
    health() {
      return audit.health();
    },
  };
}

module.exports = { toAuditPort };
