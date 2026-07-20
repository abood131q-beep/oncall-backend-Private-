'use strict';

/**
 * SDK ↔ Identity adapter (Phase 14.8 / ADR-027 §8/§9). Gives an Extension a
 * granted, namespace-isolated Identity port WITHOUT leaking engine internals or
 * credential material. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`); it cannot read or authenticate against another
 *     extension's identities.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — authenticate/refresh/revoke require `identity:authenticate`;
 *     register requires `identity:authenticate` (authoring); resolve requires
 *     `identity:read`. Missing capability → PermissionError.
 *   • No credential leakage — register returns the public model (no hash); the
 *     engine never emits secrets.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toIdentityPort(
  identity,
  { owner, canRead = true, canAuthenticate = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toIdentityPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead)
      throw new PermissionError(`extension "${owner}" lacks capability "identity:read"`);
  };
  const requireAuth = () => {
    if (!canAuthenticate) {
      throw new PermissionError(`extension "${owner}" lacks capability "identity:authenticate"`);
    }
  };

  return {
    register(spec = {}) {
      requireAuth();
      return identity.register(spec, { namespace });
    },
    authenticate(spec = {}) {
      requireAuth();
      return identity.authenticate(spec, { namespace });
    },
    refresh(spec = {}) {
      requireAuth();
      return identity.refresh(spec, { namespace });
    },
    revoke(spec = {}) {
      requireAuth();
      return identity.revoke(spec, { namespace });
    },
    resolve(spec = {}) {
      requireRead();
      return identity.resolve(spec, { namespace });
    },
    health() {
      return identity.health();
    },
  };
}

module.exports = { toIdentityPort };
