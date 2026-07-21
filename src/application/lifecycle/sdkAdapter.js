'use strict';

/**
 * SDK ↔ Lifecycle Management adapter (Phase 15.11 / ADR-040 §7/§9). Gives an
 * Extension a granted, namespace-isolated Lifecycle port WITHOUT leaking engine
 * internals or the ability to register components/hooks. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`); it can only manage/read its own components.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — status/verify/list require `lifecycle:read`; initialize/start/
 *     stop/restart require `lifecycle:manage`. Missing capability → PermissionError.
 *   • Component registration (register) is NOT exposed — declaring components + their
 *     executable hooks is administrative.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toLifecyclePort(
  lifecycle,
  { owner, canRead = true, canManage = false, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toLifecyclePort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead)
      throw new PermissionError(`extension "${owner}" lacks capability "lifecycle:read"`);
  };
  const requireManage = () => {
    if (!canManage) {
      throw new PermissionError(`extension "${owner}" lacks capability "lifecycle:manage"`);
    }
  };

  return {
    initialize(spec = {}) {
      requireManage();
      return lifecycle.initialize(spec, { namespace });
    },
    start(spec = {}) {
      requireManage();
      return lifecycle.start(spec, { namespace });
    },
    stop(spec = {}) {
      requireManage();
      return lifecycle.stop(spec, { namespace });
    },
    restart(spec = {}) {
      requireManage();
      return lifecycle.restart(spec, { namespace });
    },
    status(spec = {}) {
      requireRead();
      return lifecycle.status(spec, { namespace });
    },
    verify() {
      requireRead();
      return lifecycle.verify({ namespace });
    },
    list() {
      requireRead();
      return lifecycle.list({ namespace });
    },
    health() {
      return lifecycle.health();
    },
  };
}

module.exports = { toLifecyclePort };
