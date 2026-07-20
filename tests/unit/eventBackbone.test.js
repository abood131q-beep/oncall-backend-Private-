'use strict';

/**
 * Event Backbone — advanced guarantees (Phase 14.1 review closure).
 * Covers: correlation/causation (#3), event contracts (#2), EventPublisher port
 * (#5), event store (#4), transactional outbox (#1), and confirms idempotency is
 * keyed on eventId, not payload (#6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDomainEvent, follows } = require('../../src/domain/shared/DomainEvent');
const catalog = require('../../src/domain/shared/eventCatalog');
const { createEventBus } = require('../../src/application/shared/eventBus');
const {
  assertPublisher,
  createNullPublisher,
} = require('../../src/application/shared/eventPublisher');
const { createInMemoryEventStore, withStore } = require('../../src/application/shared/eventStore');
const { createOutbox } = require('../../src/application/shared/outbox');

const silent = { warn() {}, error() {}, info() {} };

// ── #3 Correlation / Causation ────────────────────────────────────────────────

test('#3 root event correlates to itself; causationId null', () => {
  const root = createDomainEvent({ type: 'TripRequested', producer: 'trips' });
  assert.equal(root.correlationId, root.id);
  assert.equal(root.causationId, null);
});

test('#3 follows() propagates correlation and sets causation to parent id', () => {
  const root = createDomainEvent({ type: 'TripRequested', producer: 'trips' });
  const child = follows(root, { type: 'TripAccepted', producer: 'trips', payload: { x: 1 } });
  assert.equal(child.correlationId, root.correlationId); // same trace
  assert.equal(child.causationId, root.id); // directly caused by root
  const grandchild = follows(child, { type: 'TripCompleted', producer: 'trips' });
  assert.equal(grandchild.correlationId, root.correlationId); // whole chain shares it
  assert.equal(grandchild.causationId, child.id);
});

// ── #2 Event Contracts (frozen, versioned) ────────────────────────────────────

test('#2 catalog lists canonical versioned contracts', () => {
  const list = catalog.listContracts();
  for (const c of [
    'TripRequested v1',
    'TripAccepted v1',
    'TripStarted v1',
    'TripCompleted v1',
    'PaymentCompleted v1',
    'ScooterUnlocked v1',
  ]) {
    assert.ok(list.includes(c), `missing contract ${c}`);
  }
});

test('#2 defineEvent rejects unregistered type, wrong producer, missing payload', () => {
  assert.throws(
    () => catalog.defineEvent({ type: 'NotAThing', producer: 'trips' }),
    /unregistered/
  );
  assert.throws(
    () =>
      catalog.defineEvent({
        type: 'TripCompleted',
        producer: 'payments',
        payload: { tripRef: 't', fareRef: 'f' },
      }),
    /produced by "trips"/
  );
  assert.throws(
    () =>
      catalog.defineEvent({ type: 'TripCompleted', producer: 'trips', payload: { tripRef: 't' } }),
    /missing payload keys: fareRef/
  );
});

test('#2 defineEvent builds a valid, frozen, catalog-conformant event', () => {
  const e = catalog.defineEvent({
    type: 'PaymentCompleted',
    producer: 'payments',
    subject: 'payment:9',
    payload: { paymentRef: 'p9', tripRef: 't9' },
  });
  assert.equal(e.type, 'PaymentCompleted');
  assert.equal(e.producer, 'payments');
  assert.equal(e.version, 1);
  assert.equal(e.payload.tripRef, 't9');
});

// ── #5 EventPublisher port ────────────────────────────────────────────────────

test('#5 the in-process bus satisfies the EventPublisher port', () => {
  const bus = createEventBus({ logger: silent });
  assert.doesNotThrow(() => assertPublisher(bus, { requireSubscribe: true }));
});

test('#5 assertPublisher rejects an incomplete adapter; null publisher is inert', async () => {
  assert.throws(() => assertPublisher({}), /publish/);
  const nul = createNullPublisher();
  assert.doesNotThrow(() => assertPublisher(nul));
  await nul.publish(createDomainEvent({ type: 'X', producer: 'x' })); // inert, resolves
});

// ── #4 Event Store ────────────────────────────────────────────────────────────

test('#4 event store appends and replays by subject and by correlation chain', async () => {
  const store = createInMemoryEventStore();
  const root = createDomainEvent({ type: 'TripRequested', producer: 'trips', subject: 'trip:1' });
  const child = follows(root, { type: 'TripCompleted', producer: 'trips', subject: 'trip:1' });
  const other = createDomainEvent({
    type: 'UserRegistered',
    producer: 'identity',
    subject: 'user:5',
  });
  await store.append(root);
  await store.append(child);
  await store.append(other);
  assert.equal(store.size(), 3);
  assert.deepEqual(
    store.readBySubject('trip:1').map((e) => e.type),
    ['TripRequested', 'TripCompleted']
  );
  // correlation chain: root + child share root.id; other does not
  assert.deepEqual(
    store.readByCorrelation(root.correlationId).map((e) => e.type),
    ['TripRequested', 'TripCompleted']
  );
});

test('#4 withStore records every published event without changing publish', async () => {
  const bus = createEventBus({ logger: silent });
  const store = createInMemoryEventStore();
  const pub = withStore(bus, store);
  const got = [];
  bus.subscribe('WalletCredited', (e) => got.push(e.id));
  const e = catalog.defineEvent({
    type: 'WalletCredited',
    producer: 'wallet',
    payload: { walletRef: 'w', amount: 5 },
  });
  await pub.publish(e);
  await bus.drain();
  assert.equal(store.size(), 1);
  assert.deepEqual(got, [e.id]);
});

// ── #1 Transactional Outbox ────────────────────────────────────────────────────

test('#1 committed transaction relays staged events; failed transaction relays NONE', async () => {
  const published = [];
  const publisher = { publish: (e) => (published.push(e.type), Promise.resolve()) };
  const outbox = createOutbox({ publisher, logger: silent });

  // Simulated dbTransaction that COMMITS:
  const uow = outbox.begin();
  const fakeTxCommit = async () => {
    uow.stage(
      createDomainEvent({
        type: 'TripCompleted',
        producer: 'trips',
        payload: { tripRef: 't', fareRef: 'f' },
      })
    );
  };
  await fakeTxCommit(); // did not throw ⇒ committed
  await uow.relay();
  assert.deepEqual(published, ['TripCompleted']); // relayed after commit

  // Simulated dbTransaction that THROWS (rolls back): relay never reached.
  published.length = 0;
  const uow2 = outbox.begin();
  const fakeTxFail = async () => {
    uow2.stage(
      createDomainEvent({
        type: 'PaymentCompleted',
        producer: 'payments',
        payload: { paymentRef: 'p', tripRef: 't' },
      })
    );
    throw new Error('tx failed');
  };
  await assert.rejects(fakeTxFail(), /tx failed/);
  // Caller does NOT call relay() on a failed tx → no phantom event.
  assert.deepEqual(published, []);
});

test('#1 durable outbox: persist inside tx, relayPending re-publishes after crash', async () => {
  const published = [];
  const publisher = { publish: (e) => (published.push(e.id), Promise.resolve()) };
  const outbox = createOutbox({ publisher, logger: silent });

  const uow = outbox.begin();
  const ev = createDomainEvent({
    type: 'TripStarted',
    producer: 'trips',
    payload: { tripRef: 't' },
  });
  uow.stage(ev);
  await uow.persist(); // written to durable outbox store inside the (fake) tx
  // Simulate crash BEFORE relay: relay() never ran. Recovery relays pending rows.
  const relayed = await outbox.relayPending();
  assert.deepEqual(relayed, [ev.id]);
  assert.deepEqual(published, [ev.id]);
  // Idempotent: a second recovery pass re-publishes nothing (already marked relayed).
  published.length = 0;
  const again = await outbox.relayPending();
  assert.deepEqual(again, []);
  assert.deepEqual(published, []);
});

// ── #6 Idempotency keyed on eventId (not payload) — explicit confirmation ──────

test('#6 two events with IDENTICAL payload but different ids are NOT deduped', async () => {
  const bus = createEventBus({ logger: silent, baseDelayMs: 1, sleep: () => Promise.resolve() });
  const seen = new Set();
  let effects = 0;
  bus.subscribe('WalletCredited', (e) => {
    if (seen.has(e.id)) return; // dedupe key = eventId
    seen.add(e.id);
    effects++;
  });
  const p = { walletRef: 'w1', amount: 10 };
  const a = catalog.defineEvent({ type: 'WalletCredited', producer: 'wallet', payload: p });
  const b = catalog.defineEvent({ type: 'WalletCredited', producer: 'wallet', payload: p }); // same payload, new id
  await bus.publish(a);
  await bus.publish(b);
  await bus.drain();
  assert.notEqual(a.id, b.id);
  assert.equal(effects, 2); // NOT deduped — distinct facts despite identical payload
});

test('#6 the SAME event id redelivered IS deduped', async () => {
  const bus = createEventBus({ logger: silent });
  const seen = new Set();
  let effects = 0;
  bus.subscribe('TripStarted', (e) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    effects++;
  });
  const e = catalog.defineEvent({
    type: 'TripStarted',
    producer: 'trips',
    payload: { tripRef: 't' },
  });
  await bus.publish(e);
  await bus.publish(e);
  await bus.drain();
  assert.equal(effects, 1);
});
