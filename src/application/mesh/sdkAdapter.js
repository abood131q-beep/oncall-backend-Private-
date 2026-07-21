'use strict';

/**
 * SDK ↔ Service Mesh adapter (Phase 15.8 / ADR-037 §7/§9). Gives an Extension a
 * granted, namespace-isolated Mesh port WITHOUT leaking engine internals or the
 * ability to author connections. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`); it can only invoke/read within its own namespace.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — invoke requires `mesh:invoke`; verify/list require `mesh:read`.
 *     Missing capability → PermissionError.
 *   • Connection authoring (registerPolicy/connect/disconnect) is NOT exposed — mesh
 *     topology + lifecycle is administrative.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toMeshPort(
  mesh,
  { owner, canInvoke = true, canRead = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toMeshPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireInvoke = () => {
    if (!canInvoke)
      throw new PermissionError(`extension "${owner}" lacks capability "mesh:invoke"`);
  };
  const requireRead = () => {
    if (!canRead) throw new PermissionError(`extension "${owner}" lacks capability "mesh:read"`);
  };

  return {
    invoke(spec = {}) {
      requireInvoke();
      return mesh.invoke(spec, { namespace });
    },
    verify() {
      requireRead();
      return mesh.verify({ namespace });
    },
    list() {
      requireRead();
      return mesh.list({ namespace });
    },
    health() {
      return mesh.health();
    },
  };
}

module.exports = { toMeshPort };
