'use strict';

/**
 * Compatibility event catalog (Phase 15.12 / ADR-041 §6) — PURE domain,
 * self-contained so the shared platform event catalog is untouched. Builds canonical
 * DomainEvents (producer 'compatibility'); the service publishes them ONLY through
 * the EventPublisher port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const COMPATIBILITY_EVENTS = Object.freeze({
  CONTRACT_REGISTERED: 'ContractRegistered',
  COMPATIBILITY_VERIFIED: 'CompatibilityVerified',
  CAPABILITY_NEGOTIATED: 'CapabilityNegotiated',
  VERSION_DEPRECATED: 'VersionDeprecated',
  VIOLATION_DETECTED: 'CompatibilityViolationDetected',
});

const KNOWN = new Set(Object.values(COMPATIBILITY_EVENTS));
const isCompatibilityEvent = (type) => KNOWN.has(type);

function createCompatibilityEvent(type, payload = {}, opts = {}) {
  if (!isCompatibilityEvent(type)) throw new Error(`compatibility events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'compatibility',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.contractId || payload.component)) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { COMPATIBILITY_EVENTS, isCompatibilityEvent, createCompatibilityEvent };
