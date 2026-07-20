'use strict';

/**
 * DomainEvent — the canonical event envelope (ADR-002 §8, ADR-004 fact rules).
 *
 * Pure value object: no I/O, no framework, no time source of its own beyond an
 * injectable clock (determinism, ADR-005 §19.16). An event is an immutable,
 * past-tense fact carrying references (EntityRef-style ids), never mutable
 * payloads. Meaning is fixed by (type, version): a change of meaning is a NEW
 * type or a NEW version — never an edit (ADR-006 §6 event evolution).
 *
 * Envelope shape (frozen):
 *   { id, type, version, occurredAt, producer, subject, payload }
 *     id         — unique event id (idempotency key for consumers)
 *     type       — past-tense name, e.g. 'TripCompleted'
 *     version    — integer schema version, default 1
 *     occurredAt — ISO instant (from injected clock)
 *     producer   — owning context, e.g. 'trips'
 *     subject    — the aggregate ref this event is about (for per-subject order)
 *     payload    — frozen plain data (references, not copies)
 */

let _counter = 0;

function defaultId() {
  // Monotonic, collision-resistant without external deps: time + counter + rand.
  _counter = (_counter + 1) % 1e6;
  return `evt_${Date.now().toString(36)}_${_counter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.keys(o).forEach((k) => deepFreeze(o[k]));
    Object.freeze(o);
  }
  return o;
}

/**
 * @param {object} spec
 * @param {string} spec.type      required, past-tense
 * @param {string} spec.producer  required, owning context
 * @param {object} [spec.payload] references + primitives only
 * @param {string} [spec.subject] aggregate ref for ordering
 * @param {number} [spec.version] default 1
 * @param {object} [opts] { clock, idFactory } for determinism/testing
 * @returns {Readonly<object>} frozen event envelope
 */
function createDomainEvent(spec, opts = {}) {
  if (!spec || typeof spec.type !== 'string' || !spec.type) {
    throw new Error('DomainEvent: "type" is required');
  }
  if (typeof spec.producer !== 'string' || !spec.producer) {
    throw new Error('DomainEvent: "producer" is required');
  }
  const clock = opts.clock || (() => new Date());
  const idFactory = opts.idFactory || defaultId;

  return deepFreeze({
    id: spec.id || idFactory(),
    type: spec.type,
    version: Number.isInteger(spec.version) ? spec.version : 1,
    occurredAt: (spec.occurredAt ? new Date(spec.occurredAt) : clock()).toISOString(),
    producer: spec.producer,
    subject: spec.subject || null,
    payload: spec.payload ? { ...spec.payload } : {},
  });
}

module.exports = { createDomainEvent, deepFreeze };
