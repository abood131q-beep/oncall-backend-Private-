'use strict';

/**
 * eventStore (Phase 14.1 review #4) — append-only Domain Event store.
 *
 * A port with an in-memory default; a durable adapter (SQLite/PG table) can
 * implement the same shape later without touching callers. Append-only by
 * construction (ADR-004: facts are immutable). Supports replay/audit reads by
 * subject and by correlation chain (uses the envelope's correlationId — #3).
 *
 * Port contract:
 *   append(event)              → Promise<void>
 *   readAll()                  → event[]
 *   readBySubject(subject)     → event[] (in append order)
 *   readByCorrelation(corrId)  → event[] (the full causal chain, in order)
 *   size()                     → number
 */

function createInMemoryEventStore() {
  const events = [];
  return {
    append(event) {
      if (!event || !event.id || !event.type) {
        throw new Error('eventStore.append: a DomainEvent with id and type is required');
      }
      events.push(event); // event is already frozen by createDomainEvent
      return Promise.resolve();
    },
    readAll: () => events.slice(),
    readBySubject: (subject) => events.filter((e) => e.subject === subject),
    readByCorrelation: (correlationId) => events.filter((e) => e.correlationId === correlationId),
    size: () => events.length,
  };
}

/**
 * withStore — decorate an EventPublisher so every published event is also
 * appended to the store (opt-in composition; neither side is required).
 * Store append never blocks publish semantics.
 */
function withStore(publisher, store) {
  return {
    ...publisher,
    async publish(event) {
      await store.append(event);
      return publisher.publish(event);
    },
  };
}

module.exports = { createInMemoryEventStore, withStore };
