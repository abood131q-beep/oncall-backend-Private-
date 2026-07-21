'use strict';

/**
 * Multi-Tenancy event catalog (Phase 15.9 / ADR-038 §6) — PURE domain,
 * self-contained so the shared platform event catalog is untouched. Builds
 * canonical DomainEvents (producer 'tenancy'); the service publishes them ONLY
 * through the EventPublisher port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const TENANT_EVENTS = Object.freeze({
  REGISTERED: 'TenantRegistered',
  ACTIVATED: 'TenantActivated',
  DEACTIVATED: 'TenantDeactivated',
  RESOLVED: 'TenantResolved',
  UPDATED: 'TenantUpdated',
  VERIFIED: 'TenantVerified',
});

const KNOWN = new Set(Object.values(TENANT_EVENTS));
const isTenantEvent = (type) => KNOWN.has(type);

function createTenantEvent(type, payload = {}, opts = {}) {
  if (!isTenantEvent(type)) throw new Error(`tenancy events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'tenancy',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.tenantId || payload.tenantName)) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { TENANT_EVENTS, isTenantEvent, createTenantEvent };
