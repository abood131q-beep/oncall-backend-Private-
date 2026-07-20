'use strict';

/**
 * Consumer Inbox tests (Phase 14.1 review #7) — proves exactly-once EFFECT under
 * at-least-once redelivery, per-consumer scope, dedup-by-eventId, retry-on-failure,
 * and the full Outbox→Broker→Inbox→Handler chain end to end.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDomainEvent } = require('../../src/domain/shared/DomainEvent');
const { createEventBus } = require('../../src/application/shared/eventBus');
const { createOutbox } = require('../../src/application/shared/outbox');
const { createInbox, createInMemoryInboxStore } = require('../../src/application/shared/inbox');

const silent = { warn() {}, error() {}, info() {} };

test('redelivery of the same event runs the effect exactly once', async () => {
  const inbox = createInbox({ logger: silent });
  let effects = 0;
  const guarded = inbox.guard('billing', () => {
    effects++;
  });
  const e = createDomainEvent({
    type: 'PaymentCompleted',
    producer: 'payments',
    payload: { p: 1 },
  });
  assert.equal(await guarded(e), 'processed');
  assert.equal(await guarded(e), 'skipped'); // redelivered
  assert.equal(await guarded(e), 'skipped'); // and again
  assert.equal(effects, 1);
});

test('dedupe is per-consumer: two consumers each process once (fan-out)', async () => {
  const store = createInMemoryInboxStore();
  const inbox = createInbox({ store, logger: silent });
  let billing = 0;
  let analytics = 0;
  const gBilling = inbox.guard('billing', () => billing++);
  const gAnalytics = inbox.guard('analytics', () => analytics++);
  const e = createDomainEvent({ type: 'TripCompleted', producer: 'trips', payload: { t: 1 } });
  await gBilling(e);
  await gBilling(e); // dup for billing
  await gAnalytics(e);
  await gAnalytics(e); // dup for analytics
  assert.equal(billing, 1);
  assert.equal(analytics, 1);
});

test('dedupe keys on eventId, not payload — identical payload, new id runs again', async () => {
  const inbox = createInbox({ logger: silent });
  let effects = 0;
  const g = inbox.guard('c', () => effects++);
  const payload = { walletRef: 'w', amount: 10 };
  const a = createDomainEvent({ type: 'WalletCredited', producer: 'wallet', payload });
  const b = createDomainEvent({ type: 'WalletCredited', producer: 'wallet', payload }); // same payload, new id
  await g(a);
  await g(b);
  assert.notEqual(a.id, b.id);
  assert.equal(effects, 2); // distinct facts → both processed
});

test('handler failure does NOT mark processed → redelivery retries', async () => {
  const inbox = createInbox({ logger: silent });
  let attempts = 0;
  const g = inbox.guard('c', () => {
    attempts++;
    if (attempts === 1) throw new Error('transient');
  });
  const e = createDomainEvent({ type: 'TripStarted', producer: 'trips', payload: { t: 1 } });
  await assert.rejects(g(e), /transient/); // first delivery fails, id NOT marked
  assert.equal(await g(e), 'processed'); // redelivery succeeds
  assert.equal(attempts, 2);
});

test('atomic mark: the txRunner used by the handler is passed to store.mark', async () => {
  const marks = [];
  const store = {
    has: () => Promise.resolve(false),
    mark: (consumer, id, txRunner) => {
      marks.push({ consumer, id, tx: txRunner });
      return Promise.resolve();
    },
  };
  const inbox = createInbox({ store, logger: silent });
  const tx = Symbol('txRunner');
  const g = inbox.guard('c', async () => {});
  const e = createDomainEvent({ type: 'TripStarted', producer: 'trips', payload: { t: 1 } });
  await g(e, { txRunner: tx });
  assert.equal(marks.length, 1);
  assert.equal(marks[0].tx, tx); // mark committed with the handler's tx (atomicity)
});

test('full chain — Outbox → (broker) → Inbox → Handler — effect once despite duplicate delivery', async () => {
  // Broker double-delivers everything published (models at-least-once).
  const inboxStore = createInMemoryInboxStore();
  const inbox = createInbox({ store: inboxStore, logger: silent });
  let sideEffects = 0;
  const handler = inbox.guard('notifier', () => sideEffects++);

  const broker = {
    subs: [],
    publish(e) {
      // at-least-once: deliver TWICE
      this.subs.forEach((h) => h(e));
      this.subs.forEach((h) => h(e));
      return Promise.resolve();
    },
    subscribe(h) {
      this.subs.push(h);
    },
  };
  broker.subscribe((e) => handler(e));

  const outbox = createOutbox({ publisher: broker, logger: silent });
  const uow = outbox.begin();
  // Business tx commits, stages one event:
  uow.stage(
    createDomainEvent({ type: 'TripCompleted', producer: 'trips', payload: { t: 1, fareRef: 'f' } })
  );
  await uow.relay(); // publishes once; broker fans out twice
  // allow async guards to settle
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sideEffects, 1); // exactly-once effect despite duplicate delivery
});
