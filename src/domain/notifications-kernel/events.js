'use strict';

/**
 * Notification event catalog (Phase 15.1 / ADR-030 §6) — PURE domain,
 * self-contained so the shared platform event catalog is untouched. Builds
 * canonical DomainEvents (producer 'notifications'); the service publishes them
 * ONLY through the EventPublisher port (the Event Backbone) — never a direct
 * EventBus. Payloads carry notification identity/status metadata, never rendered
 * recipient-facing secrets beyond what the caller supplied.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const NOTIFICATION_EVENTS = Object.freeze({
  CREATED: 'NotificationCreated',
  SCHEDULED: 'NotificationScheduled',
  SENT: 'NotificationSent',
  DELIVERED: 'NotificationDelivered',
  FAILED: 'NotificationFailed',
  CANCELLED: 'NotificationCancelled',
});

const KNOWN = new Set(Object.values(NOTIFICATION_EVENTS));
const isNotificationEvent = (type) => KNOWN.has(type);

function createNotificationEvent(type, payload = {}, opts = {}) {
  if (!isNotificationEvent(type)) throw new Error(`notifications events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'notifications',
      version: opts.version || 1,
      subject: opts.subject || (payload && (payload.notificationId || payload.channel)) || null,
      correlationId: opts.correlationId || (payload && payload.correlationId) || undefined,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { NOTIFICATION_EVENTS, isNotificationEvent, createNotificationEvent };
