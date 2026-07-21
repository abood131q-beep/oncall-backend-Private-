'use strict';

/**
 * Policy Adapter — translates the application's role/authorization checks (authenticate*,
 * ADMIN_PHONES) into a Policy kernel (ADR-025) decision request. INERT in Phase 17.2:
 * authorization is UNCHANGED and continues to run in the existing middleware.
 */

const { requirePort } = require('../_base');

function createPolicyAdapter({ port = null } = {}) {
  return Object.freeze({
    name: 'policy',
    kernel: 'policy (ADR-025)',
    consumed: () => port != null,
    // pure translation: app auth context → policy decision request
    toRequest: ({ subject, role, action, resource } = {}) => ({
      principal: subject != null ? String(subject) : null,
      role: role || null,
      action: action || null,
      resource: resource || null,
    }),
    // active (requires an injected Policy kernel port) — NOT used in Phase 17.2
    decide: (request) => requirePort('policy', port).decide(request),
    health: () => ({ ok: true, consumed: port != null }),
  });
}

module.exports = { createPolicyAdapter };
