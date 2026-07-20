'use strict';

/**
 * Identity event catalog (Phase 14.8 / ADR-027 §6) — PURE domain, self-contained
 * so the shared platform event catalog is untouched. Builds canonical
 * DomainEvents (producer 'identity'); the service publishes them ONLY through the
 * EventPublisher port (the Event Backbone) — never a direct EventBus. Payloads
 * never carry credentials or tokens.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const IDENTITY_EVENTS = Object.freeze({
  REGISTERED: 'IdentityRegistered',
  AUTHENTICATED: 'Authenticated',
  AUTH_FAILED: 'AuthenticationFailed',
  SESSION_CREATED: 'SessionCreated',
  SESSION_REFRESHED: 'SessionRefreshed',
  SESSION_REVOKED: 'SessionRevoked',
});

const KNOWN = new Set(Object.values(IDENTITY_EVENTS));
const isIdentityEvent = (type) => KNOWN.has(type);

function createIdentityEvent(type, payload = {}, opts = {}) {
  if (!isIdentityEvent(type)) throw new Error(`identity events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'identity',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.identityId || payload.principal)) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { IDENTITY_EVENTS, isIdentityEvent, createIdentityEvent };
