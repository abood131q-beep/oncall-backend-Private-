'use strict';

/**
 * Storage event catalog (Phase 14.3.4 §5) — PURE domain, self-contained so the
 * shared platform event catalog is untouched. Builds canonical DomainEvents
 * (producer 'storage'); the service publishes them ONLY through the
 * EventPublisher port — never a direct EventBus.
 */

const { createDomainEvent } = require('../shared/DomainEvent');

const STORAGE_EVENTS = Object.freeze({
  CREATED: 'StorageCreated',
  UPDATED: 'StorageUpdated',
  DELETED: 'StorageDeleted',
  TX_COMMITTED: 'TransactionCommitted',
  TX_ROLLED_BACK: 'TransactionRolledBack',
  PROVIDER_CHANGED: 'StorageProviderChanged',
});

const KNOWN = new Set(Object.values(STORAGE_EVENTS));
const isStorageEvent = (type) => KNOWN.has(type);

function createStorageEvent(type, payload = {}, opts = {}) {
  if (!isStorageEvent(type)) throw new Error(`storage events: unknown type "${type}"`);
  return createDomainEvent(
    {
      type,
      producer: 'storage',
      version: opts.version || 1,
      subject: opts.subject || (payload && payload.key) || null,
      correlationId: opts.correlationId,
      payload,
    },
    { clock: opts.clock, idFactory: opts.idFactory }
  );
}

module.exports = { STORAGE_EVENTS, isStorageEvent, createStorageEvent };
