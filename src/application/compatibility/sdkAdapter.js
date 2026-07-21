'use strict';

/**
 * SDK ↔ Compatibility adapter (Phase 15.12 / ADR-041 §7/§9). Gives an Extension a
 * granted, namespace-isolated Compatibility port WITHOUT leaking engine internals or the
 * ability to register/deprecate contracts. Security:
 *   • Namespace isolation — every call is forced into the extension's own namespace
 *     (`ext.<owner>`); it can only query/verify its own contracts.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — evaluate/negotiate/get/list/resolve require `compatibility:read`;
 *     verify requires `compatibility:verify`. Missing capability → PermissionError.
 *   • Contract registration (registerContract) and deprecation (deprecate) are NOT
 *     exposed — governing the contract catalog is administrative.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toCompatibilityPort(
  compatibility,
  { owner, canRead = true, canVerify = false, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toCompatibilityPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead)
      throw new PermissionError(`extension "${owner}" lacks capability "compatibility:read"`);
  };
  const requireVerify = () => {
    if (!canVerify) {
      throw new PermissionError(`extension "${owner}" lacks capability "compatibility:verify"`);
    }
  };

  return {
    evaluate(request = {}) {
      requireRead();
      return compatibility.evaluate(request, { namespace });
    },
    negotiate(request = {}) {
      requireRead();
      return compatibility.negotiate(request, { namespace });
    },
    get(request = {}) {
      requireRead();
      return compatibility.get(request, { namespace });
    },
    list() {
      requireRead();
      return compatibility.list({ namespace });
    },
    resolve(request = {}) {
      requireRead();
      return compatibility.resolve(request, { namespace });
    },
    verify(request = {}) {
      requireVerify();
      return compatibility.verify(request, { namespace });
    },
    health() {
      return compatibility.health();
    },
  };
}

module.exports = { toCompatibilityPort };
