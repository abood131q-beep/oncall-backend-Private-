'use strict';

/**
 * Resilience event catalog (Phase 15.7 / ADR-036 §6) — PURE domain, self-contained
 * so the shared platform event catalog is untouched. Builds canonical DomainEvents
 * (producer 'resilience'); the service publishes them ONLY through the EventPublisher
 * port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const RESILIENCE_EVENTS = Object.freeze({
  POLICY_REGISTERED: 'PolicyRegistered',
  EXECUTION_STARTED: 'ExecutionStarted',
  EXECUTION_SUCCEEDED: 'ExecutionSucceeded',
  EXECUTION_FAILED: 'ExecutionFailed',
  CIRCUIT_OPENED: 'CircuitOpened',
  CIRCUIT_HALF_OPENED: 'CircuitHalfOpened',
  CIRCUIT_CLOSED: 'CircuitClosed',
  FALLBACK_EXECUTED: 'FallbackExecuted',
  RECOVERY_COMPLETED: 'RecoveryCompleted',
});

const KNOWN = new Set(Object.values(RESILIENCE_EVENTS));
const isResilienceEvent = (type) => KNOWN.has(type);

function createResilienceEvent(type, payload = {}, opts = {}) {
  if (!isResilienceEvent(type)) throw new Error(`resilience events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'resilience',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.policyId || payload.executionId)) || null,
      correlationId: opts.correlationId || (payload && payload.correlationId) || undefined,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { RESILIENCE_EVENTS, isResilienceEvent, createResilienceEvent };
