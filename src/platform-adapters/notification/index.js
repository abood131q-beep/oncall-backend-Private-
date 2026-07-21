'use strict';

/**
 * Notification Adapter — translates the application's notification / SMS / push payloads
 * (notificationService, smsService, otpService, device_tokens) into a Notifications kernel
 * (ADR-030) message. INERT in Phase 17.2: delivery continues through the existing services.
 */

const { requirePort } = require('../_base');

function createNotificationAdapter({ port = null } = {}) {
  return Object.freeze({
    name: 'notification',
    kernel: 'notifications (ADR-030)',
    consumed: () => port != null,
    // pure translation: app notification → kernel message
    toMessage: ({ to, channel = 'push', template, data = {} } = {}) => ({
      recipient: to != null ? String(to) : null,
      channel: String(channel),
      template: template || null,
      payload: { ...data },
    }),
    // active (requires an injected Notifications kernel port) — NOT used in Phase 17.2
    send: (message) => requirePort('notification', port).send(message),
    health: () => ({ ok: true, consumed: port != null }),
  });
}

module.exports = { createNotificationAdapter };
