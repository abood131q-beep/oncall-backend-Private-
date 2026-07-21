'use strict';

/**
 * Service Discovery event catalog (Phase 15.5 / ADR-034 §6) — PURE domain,
 * self-contained so the shared platform event catalog is untouched. Builds
 * canonical DomainEvents (producer 'discovery'); the service publishes them ONLY
 * through the EventPublisher port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const DISCOVERY_EVENTS = Object.freeze({
  SERVICE_REGISTERED: 'ServiceRegistered',
  SERVICE_UPDATED: 'ServiceUpdated',
  SERVICE_RESOLVED: 'ServiceResolved',
  SERVICE_UNAVAILABLE: 'ServiceUnavailable',
  DISCOVERY_VERIFIED: 'DiscoveryVerified',
});

const KNOWN = new Set(Object.values(DISCOVERY_EVENTS));
const isDiscoveryEvent = (type) => KNOWN.has(type);

function createDiscoveryEvent(type, payload = {}, opts = {}) {
  if (!isDiscoveryEvent(type)) throw new Error(`discovery events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'discovery',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.serviceId || payload.serviceName)) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { DISCOVERY_EVENTS, isDiscoveryEvent, createDiscoveryEvent };
