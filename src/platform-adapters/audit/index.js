'use strict';

/**
 * Audit Adapter — translates the application's audit events (login_logs,
 * driver_approval_logs, admin actions) into an Audit kernel (ADR-026) record. INERT in
 * Phase 17.2: audit rows continue to be written by the existing application code, unchanged.
 */

const { requirePort } = require('../_base');

function createAuditAdapter({ port = null } = {}) {
  return Object.freeze({
    name: 'audit',
    kernel: 'audit (ADR-026)',
    consumed: () => port != null,
    // pure translation: app audit event → audit record
    toRecord: ({ actor, action, target, at, meta = {} } = {}) => ({
      actor: actor != null ? String(actor) : null,
      action: action || null,
      target: target != null ? String(target) : null,
      timestamp: at || null,
      metadata: { ...meta },
    }),
    // active (requires an injected Audit kernel port) — NOT used in Phase 17.2
    write: (record) => requirePort('audit', port).write(record),
    health: () => ({ ok: true, consumed: port != null }),
  });
}

module.exports = { createAuditAdapter };
