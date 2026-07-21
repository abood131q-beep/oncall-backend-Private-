'use strict';

/**
 * Messaging Adapter — translates an application event into a Messaging kernel (ADR-024)
 * message envelope. INERT in Phase 17.2: Socket.IO and any in-process events continue to
 * flow exactly as before; nothing is published to the kernel.
 */

const { requirePort } = require('../_base');

function createMessagingAdapter({ port = null } = {}) {
  return Object.freeze({
    name: 'messaging',
    kernel: 'messaging (ADR-024)',
    consumed: () => port != null,
    // pure translation: app event → message envelope
    toEnvelope: ({ topic, type, data = {}, at } = {}) => ({
      topic: topic || null,
      type: type || null,
      body: { ...data },
      timestamp: at || null,
    }),
    // active (requires an injected Messaging kernel port) — NOT used in Phase 17.2
    publish: (envelope) => requirePort('messaging', port).publish(envelope),
    health: () => ({ ok: true, consumed: port != null }),
  });
}

module.exports = { createMessagingAdapter };
