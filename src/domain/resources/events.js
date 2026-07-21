'use strict';

/**
 * Resource Management event catalog (Phase 15.10 / ADR-039 §6) — PURE domain,
 * self-contained so the shared platform event catalog is untouched. Builds
 * canonical DomainEvents (producer 'resources'); the service publishes them ONLY
 * through the EventPublisher port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const RESOURCE_EVENTS = Object.freeze({
  REGISTERED: 'ResourceRegistered',
  ALLOCATED: 'ResourceAllocated',
  RELEASED: 'ResourceReleased',
  QUOTA_EXCEEDED: 'QuotaExceeded',
  UPDATED: 'ResourceUpdated',
  VERIFIED: 'ResourceVerified',
});

const KNOWN = new Set(Object.values(RESOURCE_EVENTS));
const isResourceEvent = (type) => KNOWN.has(type);

function createResourceEvent(type, payload = {}, opts = {}) {
  if (!isResourceEvent(type)) throw new Error(`resources events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'resources',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.resourceId || payload.allocationId)) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { RESOURCE_EVENTS, isResourceEvent, createResourceEvent };
