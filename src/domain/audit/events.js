'use strict';

/**
 * Audit event catalog (Phase 14.7 / ADR-026 §6) — PURE domain, self-contained so
 * the shared platform event catalog is untouched. Builds canonical DomainEvents
 * (producer 'audit'); the service publishes them ONLY through the EventPublisher
 * port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const AUDIT_EVENTS = Object.freeze({
  RECORDED: 'AuditRecorded',
  VERIFIED: 'AuditVerified',
  INTEGRITY_FAILURE: 'AuditIntegrityFailure',
});

const KNOWN = new Set(Object.values(AUDIT_EVENTS));
const isAuditEvent = (type) => KNOWN.has(type);

function createAuditEvent(type, payload = {}, opts = {}) {
  if (!isAuditEvent(type)) throw new Error(`audit events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'audit',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.auditId || payload.namespace)) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { AUDIT_EVENTS, isAuditEvent, createAuditEvent };
