'use strict';

/**
 * Feature Flag event catalog (Phase 15.0 / ADR-029 §6) — PURE domain,
 * self-contained so the shared platform event catalog is untouched. Builds
 * canonical DomainEvents (producer 'features'); the service publishes them ONLY
 * through the EventPublisher port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const FEATURE_EVENTS = Object.freeze({
  REGISTERED: 'FeatureRegistered',
  UPDATED: 'FeatureUpdated',
  ENABLED: 'FeatureEnabled',
  DISABLED: 'FeatureDisabled',
  EVALUATED: 'FeatureEvaluated',
  REJECTED: 'FeatureRejected',
});

const KNOWN = new Set(Object.values(FEATURE_EVENTS));
const isFeatureEvent = (type) => KNOWN.has(type);

function createFeatureEvent(type, payload = {}, opts = {}) {
  if (!isFeatureEvent(type)) throw new Error(`features events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'features',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.flagId || payload.name)) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { FEATURE_EVENTS, isFeatureEvent, createFeatureEvent };
