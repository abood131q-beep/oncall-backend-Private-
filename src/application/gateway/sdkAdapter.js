'use strict';

/**
 * SDK ↔ API Gateway adapter (Phase 15.6 / ADR-035 §7/§9). Gives an Extension a
 * granted, namespace-isolated Gateway port WITHOUT leaking engine internals or the
 * ability to register routes/middleware. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`); it can only resolve/dispatch within its own
 *     namespace.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — resolve/listRoutes/verify require `gateway:read`; dispatch
 *     requires `gateway:dispatch`. Missing capability → PermissionError.
 *   • Route + middleware registration is NOT exposed — defining routing topology and
 *     executable middleware is administrative.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toGatewayPort(
  gateway,
  { owner, canRead = true, canDispatch = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toGatewayPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead) throw new PermissionError(`extension "${owner}" lacks capability "gateway:read"`);
  };
  const requireDispatch = () => {
    if (!canDispatch) {
      throw new PermissionError(`extension "${owner}" lacks capability "gateway:dispatch"`);
    }
  };

  return {
    resolve(spec = {}) {
      requireRead();
      return gateway.resolve(spec, { namespace });
    },
    dispatch(spec = {}) {
      requireDispatch();
      return gateway.dispatch(spec, { namespace });
    },
    listRoutes() {
      requireRead();
      return gateway.listRoutes({ namespace });
    },
    verify() {
      requireRead();
      return gateway.verify({ namespace });
    },
    health() {
      return gateway.health();
    },
  };
}

module.exports = { toGatewayPort };
