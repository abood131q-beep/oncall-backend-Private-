'use strict';

/**
 * API Gateway event catalog (Phase 15.6 / ADR-035 §6) — PURE domain, self-contained
 * so the shared platform event catalog is untouched. Builds canonical DomainEvents
 * (producer 'gateway'); the service publishes them ONLY through the EventPublisher
 * port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const GATEWAY_EVENTS = Object.freeze({
  ROUTE_REGISTERED: 'RouteRegistered',
  ROUTE_UPDATED: 'RouteUpdated',
  ROUTE_RESOLVED: 'RouteResolved',
  REQUEST_DISPATCHED: 'RequestDispatched',
  GATEWAY_REJECTED: 'GatewayRejected',
  GATEWAY_VERIFIED: 'GatewayVerified',
});

const KNOWN = new Set(Object.values(GATEWAY_EVENTS));
const isGatewayEvent = (type) => KNOWN.has(type);

function createGatewayEvent(type, payload = {}, opts = {}) {
  if (!isGatewayEvent(type)) throw new Error(`gateway events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'gateway',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.routeId || payload.path)) || null,
      correlationId: opts.correlationId || (payload && payload.correlationId) || undefined,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { GATEWAY_EVENTS, isGatewayEvent, createGatewayEvent };
