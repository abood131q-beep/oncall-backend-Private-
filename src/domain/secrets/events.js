'use strict';

/**
 * Secrets event catalog (Phase 14.9 / ADR-028 §6) — PURE domain, self-contained
 * so the shared platform event catalog is untouched. Builds canonical
 * DomainEvents (producer 'secrets'); the service publishes them ONLY through the
 * EventPublisher port (the Event Backbone) — never a direct EventBus. Payloads
 * NEVER carry a secret value (only id/name/namespace/version metadata).
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const SECRET_EVENTS = Object.freeze({
  STORED: 'SecretStored',
  RESOLVED: 'SecretResolved',
  ROTATED: 'SecretRotated',
  DELETED: 'SecretDeleted',
});

const KNOWN = new Set(Object.values(SECRET_EVENTS));
const isSecretEvent = (type) => KNOWN.has(type);

function createSecretEvent(type, payload = {}, opts = {}) {
  if (!isSecretEvent(type)) throw new Error(`secrets events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'secrets',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.secretId || payload.name)) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { SECRET_EVENTS, isSecretEvent, createSecretEvent };
