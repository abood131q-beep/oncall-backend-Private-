'use strict';

/**
 * Policy event catalog (Phase 14.6 / ADR-025 §6) — PURE domain, self-contained so
 * the shared platform event catalog is untouched. Builds canonical DomainEvents
 * (producer 'policy'); the service publishes them ONLY through the EventPublisher
 * port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const POLICY_EVENTS = Object.freeze({
  REGISTERED: 'PolicyRegistered',
  UPDATED: 'PolicyUpdated',
  ENABLED: 'PolicyEnabled',
  DISABLED: 'PolicyDisabled',
  EVALUATED: 'PolicyEvaluated',
  REJECTED: 'PolicyRejected',
});

const KNOWN = new Set(Object.values(POLICY_EVENTS));
const isPolicyEvent = (type) => KNOWN.has(type);

function createPolicyEvent(type, payload = {}, opts = {}) {
  if (!isPolicyEvent(type)) throw new Error(`policy events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'policy',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.policyId || payload.scope)) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { POLICY_EVENTS, isPolicyEvent, createPolicyEvent };
