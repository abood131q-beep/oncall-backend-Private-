'use strict';

/**
 * Event Backbone tests (Phase 14.1) — proves the domain-event envelope and the
 * in-process dispatcher: subscription, isolation, retry, dead-letter, versioning,
 * idempotency-aid, and fire-and-forget publish. Pure: no transport, no storage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDomainEvent } = require('../../src/domain/shared/DomainEvent');
const { createEventBus, createInMemoryDLQ } = require('../../src/application/shared/eventBus');

const silentLog = { warn() {}, error() {}, info() {} };
const busOpts = (extra = {}) => ({
  logger: silentLog,
  baseDelayMs: 1,
  sleep: () => Promise.resolve(),
  ...extra,
});

// ── DomainEvent envelope ──────────────────────────────────────────────────────

test('DomainEvent: frozen, defaulted, deterministic under injected clock/id', () => {
  const fixed = new Date('2026-07-20T00:00:00.000Z');
  const e = createDomainEvent(
    { type: 'TripCompleted', producer: 'trips', subject: 'trip:1', payload: { tripRef: 't1' } },
    { clock: () => fixed, idFactory: () => 'evt_fixed' }
  );
  assert.equal(e.id, 'evt_fixed');
  assert.equal(e.type, 'TripCompleted');
  assert.equal(e.version, 1); // default
  assert.equal(e.occurredAt, '2026-07-20T00:00:00.000Z');
  assert.equal(e.subject, 'trip:1');
  assert.equal(e.payload.tripRef, 't1');
  assert.throws(() => {
    e.payload.tripRef = 'mutated';
  }, /Cannot assign|read only/i);
});

test('DomainEvent: type and producer are required', () => {
  assert.throws(() => createDomainEvent({ producer: 'x' }), /type/);
  assert.throws(() => createDomainEvent({ type: 'X' }), /producer/);
});

// ── Bus: subscribe + deliver ────────────────────────────────────────────────

test('publish delivers to every subscriber of the type; other types untouched', async () => {
  const bus = createEventBus(busOpts());
  const got = [];
  bus.subscribe('TripCompleted', (e) => got.push('A:' + e.payload.n));
  bus.subscribe('TripCompleted', (e) => got.push('B:' + e.payload.n));
  bus.subscribe('PaymentCompleted', () => got.push('X'));
  await bus.publish(
    createDomainEvent({ type: 'TripCompleted', producer: 'trips', payload: { n: 1 } })
  );
  await bus.drain();
  assert.deepEqual(got.sort(), ['A:1', 'B:1']); // X not called
});

test('publish with no subscribers is a no-op (never throws)', async () => {
  const bus = createEventBus(busOpts());
  await bus.publish(createDomainEvent({ type: 'Nobody', producer: 'x' }));
  assert.equal(bus.stats().delivered, 0);
});

// ── Isolation ────────────────────────────────────────────────────────────────

test('a throwing handler never blocks other handlers or the publisher', async () => {
  const bus = createEventBus(busOpts({ maxRetries: 0 }));
  const good = [];
  bus.subscribe(
    'E',
    () => {
      throw new Error('boom');
    },
    { name: 'bad' }
  );
  bus.subscribe('E', () => good.push('ok'), { name: 'good' });
  await bus.publish(createDomainEvent({ type: 'E', producer: 'x' }));
  await bus.drain();
  assert.deepEqual(good, ['ok']);
  assert.equal(bus.stats().deadLettered, 1); // the bad one parked
});

// ── Retry ────────────────────────────────────────────────────────────────────

test('transient failure is retried then succeeds (no dead-letter)', async () => {
  const bus = createEventBus(busOpts({ maxRetries: 3 }));
  let calls = 0;
  bus.subscribe('R', () => {
    calls++;
    if (calls < 3) throw new Error('transient');
  });
  await bus.publish(createDomainEvent({ type: 'R', producer: 'x' }));
  await bus.drain();
  assert.equal(calls, 3);
  assert.equal(bus.stats().delivered, 1);
  assert.equal(bus.stats().deadLettered, 0);
});

// ── Dead-letter queue ──────────────────────────────────────────────────────────

test('exhausted retries park the event in the DLQ with evidence', async () => {
  const dlq = createInMemoryDLQ();
  const bus = createEventBus(busOpts({ maxRetries: 2, deadLetterQueue: dlq }));
  bus.subscribe(
    'D',
    () => {
      throw new Error('always fails');
    },
    { name: 'failer' }
  );
  const ev = createDomainEvent({ type: 'D', producer: 'x', payload: { k: 1 } });
  await bus.publish(ev);
  await bus.drain();
  assert.equal(dlq.size(), 1);
  const parked = dlq.list()[0];
  assert.equal(parked.event.id, ev.id);
  assert.equal(parked.handler, 'failer');
  assert.equal(parked.attempts, 3); // initial + 2 retries
  assert.match(parked.error, /always fails/);
  assert.ok(parked.parkedAt);
});

// ── Versioning ────────────────────────────────────────────────────────────────

test('version-pinned subscriber only receives its version; others ignored cleanly', async () => {
  const bus = createEventBus(busOpts());
  const v1 = [];
  const v2 = [];
  bus.subscribe('Versioned', (e) => v1.push(e.version), { version: 1 });
  bus.subscribe('Versioned', (e) => v2.push(e.version), { version: 2 });
  await bus.publish(createDomainEvent({ type: 'Versioned', producer: 'x', version: 1 }));
  await bus.publish(createDomainEvent({ type: 'Versioned', producer: 'x', version: 2 }));
  await bus.drain();
  assert.deepEqual(v1, [1]);
  assert.deepEqual(v2, [2]);
  assert.equal(bus.stats().deadLettered, 0); // version mismatch is NOT a failure
});

// ── Idempotency aid ────────────────────────────────────────────────────────────

test('handlers can dedupe by event id (idempotent consumption)', async () => {
  const bus = createEventBus(busOpts());
  const seen = new Set();
  let effects = 0;
  bus.subscribe('I', (e) => {
    if (seen.has(e.id)) return; // redelivery guard
    seen.add(e.id);
    effects++;
  });
  const ev = createDomainEvent({ type: 'I', producer: 'x' });
  await bus.publish(ev);
  await bus.publish(ev); // same id redelivered
  await bus.drain();
  assert.equal(effects, 1);
});

// ── Unsubscribe ────────────────────────────────────────────────────────────────

test('unsubscribe stops further delivery', async () => {
  const bus = createEventBus(busOpts());
  let n = 0;
  const off = bus.subscribe('U', () => n++);
  await bus.publish(createDomainEvent({ type: 'U', producer: 'x' }));
  await bus.drain();
  off();
  await bus.publish(createDomainEvent({ type: 'U', producer: 'x' }));
  await bus.drain();
  assert.equal(n, 1);
});

// ── Fire-and-forget contract ────────────────────────────────────────────────

test('publish resolves without waiting for a slow handler (non-blocking)', async () => {
  const bus = createEventBus(busOpts());
  let handlerDone = false;
  bus.subscribe('Slow', async () => {
    await new Promise((r) => setTimeout(r, 30));
    handlerDone = true;
  });
  const ev = createDomainEvent({ type: 'Slow', producer: 'x' });
  // We do NOT await publish's full completion here; we assert it returns a promise
  // and the handler hasn't finished synchronously.
  const p = bus.publish(ev);
  assert.equal(handlerDone, false);
  await p;
  await bus.drain();
  assert.equal(handlerDone, true);
});
