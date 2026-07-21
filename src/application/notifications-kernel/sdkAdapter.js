'use strict';

/**
 * SDK ↔ Notification adapter (Phase 15.1 / ADR-030 §7/§9). Gives an Extension a
 * granted, namespace-isolated Notification port WITHOUT leaking engine internals or
 * the ability to register channels. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`); it cannot send to or read another extension's
 *     notifications.
 *   • Ownership — the namespace is forced; callers cannot override it.
 *   • Permission — send/schedule/cancel require `notification:send`; status/verify
 *     require `notification:read`. Missing capability → PermissionError.
 *   • Channel registration is NOT exposed — wiring transports is administrative.
 */

const { PermissionError } = require('../../sdk/extensions/errors');

function toNotificationPort(
  notifications,
  { owner, canSend = true, canRead = true, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toNotificationPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireSend = () => {
    if (!canSend) {
      throw new PermissionError(`extension "${owner}" lacks capability "notification:send"`);
    }
  };
  const requireRead = () => {
    if (!canRead) {
      throw new PermissionError(`extension "${owner}" lacks capability "notification:read"`);
    }
  };

  return {
    send(spec = {}) {
      requireSend();
      return notifications.send(spec, { namespace });
    },
    schedule(spec = {}) {
      requireSend();
      return notifications.schedule(spec, { namespace });
    },
    cancel(spec = {}) {
      requireSend();
      return notifications.cancel(spec, { namespace });
    },
    status(spec = {}) {
      requireRead();
      return notifications.status(spec, { namespace });
    },
    verify() {
      requireRead();
      return notifications.verify({ namespace });
    },
    health() {
      return notifications.health();
    },
  };
}

module.exports = { toNotificationPort };
