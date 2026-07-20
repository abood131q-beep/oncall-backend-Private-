'use strict';

/**
 * Messaging event catalog (Phase 14.5 / ADR-024 §6) — PURE domain, self-contained
 * so the shared platform event catalog is untouched. Builds canonical
 * DomainEvents (producer 'messaging'); the service publishes them ONLY through
 * the EventPublisher port (the Event Backbone) — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const MESSAGING_EVENTS = Object.freeze({
  PUBLISHED: 'MessagePublished',
  DELIVERED: 'MessageDelivered',
  EXPIRED: 'MessageExpired',
  RETRIED: 'MessageRetried',
  DEAD_LETTERED: 'DeadLettered',
  SUBSCRIBER_REGISTERED: 'SubscriberRegistered',
  SUBSCRIBER_REMOVED: 'SubscriberRemoved',
});

const KNOWN = new Set(Object.values(MESSAGING_EVENTS));
const isMessagingEvent = (type) => KNOWN.has(type);

function createMessagingEvent(type, payload = {}, opts = {}) {
  if (!isMessagingEvent(type)) throw new Error(`messaging events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'messaging',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.messageId || payload.topic)) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { MESSAGING_EVENTS, isMessagingEvent, createMessagingEvent };
