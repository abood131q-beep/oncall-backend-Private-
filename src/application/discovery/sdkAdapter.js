'use strict';

/**
 * SDK ↔ Service Discovery adapter (Phase 15.5 / ADR-034 §7/§9). Gives an Extension
 * a granted, namespace-isolated Discovery port WITHOUT leaking engine internals or
 * the ability to register services. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`); it can only discover/resolve within its own
 *     namespace.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — discover/list/verify require `discovery:read`; resolve requires
 *     `discovery:resolve`. Missing capability → PermissionError.
 *   • Service registration (register) is NOT exposed — publishing an endpoint is
 *     administrative.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toDiscoveryPort(
  discovery,
  { owner, canRead = true, canResolve = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toDiscoveryPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead) {
      throw new PermissionError(`extension "${owner}" lacks capability "discovery:read"`);
    }
  };
  const requireResolve = () => {
    if (!canResolve) {
      throw new PermissionError(`extension "${owner}" lacks capability "discovery:resolve"`);
    }
  };

  return {
    discover(spec = {}) {
      requireRead();
      return discovery.discover(spec, { namespace });
    },
    resolve(spec = {}) {
      requireResolve();
      return discovery.resolve(spec, { namespace });
    },
    list() {
      requireRead();
      return discovery.list({ namespace });
    },
    verify() {
      requireRead();
      return discovery.verify({ namespace });
    },
    health() {
      return discovery.health();
    },
  };
}

module.exports = { toDiscoveryPort };
