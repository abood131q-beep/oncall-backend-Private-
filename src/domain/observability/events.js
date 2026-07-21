'use strict';

/**
 * Observability event catalog (Phase 15.4 / ADR-033 §6) — PURE domain,
 * self-contained so the shared platform event catalog is untouched. Builds
 * canonical DomainEvents (producer 'observability'); the service publishes them
 * ONLY through the EventPublisher port (the Event Backbone) — never a direct
 * EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const OBSERVABILITY_EVENTS = Object.freeze({
  METRICS_COLLECTED: 'MetricsCollected',
  SNAPSHOT_CREATED: 'SnapshotCreated',
  HEALTH_CHANGED: 'HealthChanged',
  DIAGNOSTICS_GENERATED: 'DiagnosticsGenerated',
  VERIFICATION_COMPLETED: 'VerificationCompleted',
});

const KNOWN = new Set(Object.values(OBSERVABILITY_EVENTS));
const isObservabilityEvent = (type) => KNOWN.has(type);

function createObservabilityEvent(type, payload = {}, opts = {}) {
  if (!isObservabilityEvent(type)) {
    throw new Error(`observability events: unknown type "${type}"`);
  }
  return createDomainEvent(
    {
      type,
      producer: 'observability',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.componentId || payload.snapshotId)) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { OBSERVABILITY_EVENTS, isObservabilityEvent, createObservabilityEvent };
