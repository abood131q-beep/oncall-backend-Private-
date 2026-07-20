'use strict';

/**
 * SDK ↔ Secrets adapter (Phase 14.9 / ADR-028 §8/§9). Gives an Extension a
 * granted, namespace-isolated Secrets port WITHOUT leaking engine internals or
 * secret material. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`); it cannot read or write another extension's
 *     secrets.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — resolve/list require `secrets:read`; store/rotate/delete
 *     require `secrets:write`. Missing capability → PermissionError.
 *   • Secure redaction — store/rotate/list return redacted models; only resolve
 *     reveals a value, and only when `secrets:read` is granted.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toSecretsPort(
  secrets,
  { owner, canRead = true, canWrite = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toSecretsPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead) throw new PermissionError(`extension "${owner}" lacks capability "secrets:read"`);
  };
  const requireWrite = () => {
    if (!canWrite) {
      throw new PermissionError(`extension "${owner}" lacks capability "secrets:write"`);
    }
  };

  return {
    store(spec = {}) {
      requireWrite();
      return secrets.store(spec, { namespace });
    },
    resolve(spec = {}) {
      requireRead();
      return secrets.resolve(spec, { namespace });
    },
    rotate(spec = {}) {
      requireWrite();
      return secrets.rotate(spec, { namespace });
    },
    delete(spec = {}) {
      requireWrite();
      return secrets.delete(spec, { namespace });
    },
    list() {
      requireRead();
      return secrets.list({ namespace });
    },
    health() {
      return secrets.health();
    },
  };
}

module.exports = { toSecretsPort };
