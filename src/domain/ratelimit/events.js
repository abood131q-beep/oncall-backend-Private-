'use strict';

/**
 * Rate Limiting event catalog (Phase 15.2 / ADR-031 §6) — PURE domain,
 * self-contained so the shared platform event catalog is untouched. Builds
 * canonical DomainEvents (producer 'ratelimit'); the service publishes them ONLY
 * through the EventPublisher port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const RATE_EVENTS = Object.freeze({
  POLICY_REGISTERED: 'RatePolicyRegistered',
  EVALUATED: 'RateLimitEvaluated',
  CONSUMED: 'QuotaConsumed',
  EXCEEDED: 'QuotaExceeded',
  RESET: 'QuotaReset',
});

const KNOWN = new Set(Object.values(RATE_EVENTS));
const isRateEvent = (type) => KNOWN.has(type);

function createRateEvent(type, payload = {}, opts = {}) {
  if (!isRateEvent(type)) throw new Error(`ratelimit events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'ratelimit',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.policyId || payload.subject)) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { RATE_EVENTS, isRateEvent, createRateEvent };
