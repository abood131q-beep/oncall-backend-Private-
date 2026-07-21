'use strict';

/**
 * Lifecycle Adapter — translates an application component's start/stop into the shape the
 * Lifecycle kernel (ADR-040) expects for a lifecycle component. Pure shape translation;
 * the Host already drives OnCallAppService.start()/stop() in Phase 17.2, so no kernel
 * lifecycle registration is performed here (INERT — no port).
 */

const { requirePort } = require('../_base');

function createLifecycleAdapter({ port = null } = {}) {
  return Object.freeze({
    name: 'lifecycle',
    kernel: 'lifecycle (ADR-040)',
    consumed: () => port != null,
    // pure translation: app component → lifecycle component descriptor
    toComponent: ({ id, dependsOn = [], start, stop } = {}) => ({
      componentId: id,
      componentType: 'application',
      dependencies: [...dependsOn],
      hooks: {
        ...(typeof start === 'function' ? { start } : {}),
        ...(typeof stop === 'function' ? { stop } : {}),
      },
    }),
    // active (requires an injected Lifecycle kernel port)
    register: (descriptor) => requirePort('lifecycle', port).register(descriptor),
    health: () => ({ ok: true, consumed: port != null }),
  });
}

module.exports = { createLifecycleAdapter };
