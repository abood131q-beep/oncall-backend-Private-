'use strict';

/**
 * Lock event catalog (Phase 14.3.5 §6) — PURE domain, self-contained so the
 * shared platform event catalog is untouched. Builds canonical DomainEvents
 * (producer 'lock'); the service publishes them ONLY through the EventPublisher
 * port — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const LOCK_EVENTS = Object.freeze({
  ACQUIRED: 'LockAcquired',
  RELEASED: 'LockReleased',
  EXPIRED: 'LockExpired',
  RENEWED: 'LockRenewed',
  CONFLICT: 'LockConflict',
});

const KNOWN = new Set(Object.values(LOCK_EVENTS));
const isLockEvent = (type) => KNOWN.has(type);

function createLockEvent(type, payload = {}, opts = {}) {
  if (!isLockEvent(type)) throw new Error(`lock events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'lock',
      version: opts.version || 1,
      subject: opts.subject || (payload && payload.lockId) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { LOCK_EVENTS, isLockEvent, createLockEvent };
