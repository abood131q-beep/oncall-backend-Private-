'use strict';

/**
 * Enterprise Messaging tests (Phase 14.5 / ADR-024) — covers every required
 * category: unit (message + provider + metrics), routing (p2p / pub-sub /
 * broadcast / request-reply), retry, TTL, dead letter, concurrency, stress, and
 * failure injection, plus events-via-port and the SDK owner-scoped adapter
 * (topic isolation + capability gates). Deterministic: clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMessage, isExpired } = require('../../src/domain/messaging/message');
const { createMessagingPlatform, providers } = require('../../src/application/messaging');
const { createMessagingMetrics } = require('../../src/application/messaging/metrics');
const { toMessagingPort } = require('../../src/application/messaging/sdkAdapter');
const { RequestTimeoutError, NoSubscriberError } = require('../../src/domain/messaging/errors');

function makeClock(start = 1000) {
  const box = { now: start };
  const clock = () => box.now;
  clock.set = (n) => (box.now = n);
  return clock;
}
function recordingPublisher() {
  const events = [];
  return { events, publish: (e) => (events.push(e), Promise.resolve()) };
}

// ── domain: message ────────────────────────────────────────────────────────────

test('message: envelope fields, correlation defaulting, TTL', () => {
  const clock = makeClock(1000);
  const m = createMessage(
    { topic: 't', payload: { a: 1 }, ttlMs: 100, priority: 'high' },
    { clock }
  );
  assert.ok(m.messageId.startsWith('msg_'));
  assert.equal(m.correlationId, m.messageId); // root correlates to itself
  assert.equal(m.topic, 't');
  assert.equal(m.channel, 'default');
  assert.equal(m.expiresAt, 1100);
  assert.ok(!isExpired(m, 1099));
  assert.ok(isExpired(m, 1101));
  assert.throws(() => createMessage({}), /topic/);
});

// ── provider + future extension points ─────────────────────────────────────────

test('provider: memory select/selectAll + future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  mem.subscribe('t', () => {}, { group: 'g' });
  mem.subscribe('t', () => {}, { group: 'g' });
  mem.subscribe('t', () => {}, { group: 'other' });
  assert.equal(mem.select('t').length, 2); // one per group (g, other)
  assert.equal(mem.selectAll('t').length, 3); // everyone
  assert.equal(mem.subscriberCount('t'), 3);

  assert.ok(providers.FUTURE_PROVIDERS.includes('kafka'));
  const p = providers.futureProvider('nats');
  assert.equal(p.planned, true);
  assert.throws(() => p.select('t'), /extension point/);
});

// ── metrics ──────────────────────────────────────────────────────────────────

test('metrics: counters + prometheus', () => {
  const m = createMessagingMetrics({ clock: () => 0 });
  m.recordPublished();
  m.recordDelivered(2);
  m.recordFailed(1);
  m.recordRetry();
  m.recordDeadLetter();
  m.recordDeliveryLatency(5);
  const s = m.snapshot();
  assert.equal(s.published, 1);
  assert.equal(s.delivered, 2);
  assert.equal(s.deadLetters, 1);
  assert.match(m.prometheus(), /messaging_published_total 1/);
  assert.match(m.prometheus(), /messaging_dead_letters_total 1/);
});

// ── routing: pub/sub ────────────────────────────────────────────────────────────

test('routing: pub/sub delivers to every distinct subscriber; events via port', async () => {
  const clock = makeClock();
  const pub = recordingPublisher();
  const mq = createMessagingPlatform({ clock, publisher: pub });
  const a = [];
  const b = [];
  mq.messaging.subscribe({ topic: 'trips', handler: (m) => a.push(m.payload.id) });
  mq.messaging.subscribe({ topic: 'trips', handler: (m) => b.push(m.payload.id) });
  const r = await mq.messaging.publish({ topic: 'trips', payload: { id: 1 } });
  assert.equal(r.delivered, 2);
  assert.deepEqual(a, [1]);
  assert.deepEqual(b, [1]);
  const types = pub.events.map((e) => e.type);
  assert.ok(types.includes('MessagePublished') && types.includes('MessageDelivered'));
  assert.ok(pub.events.every((e) => e.producer === 'messaging'));
});

// ── routing: point-to-point (competing consumers) ──────────────────────────────

test('routing: same group = point-to-point round-robin (each message once)', async () => {
  const clock = makeClock();
  const mq = createMessagingPlatform({ clock });
  const got = [];
  mq.messaging.subscribe({
    topic: 'work',
    group: 'w',
    handler: (m) => got.push('s1:' + m.payload.n),
  });
  mq.messaging.subscribe({
    topic: 'work',
    group: 'w',
    handler: (m) => got.push('s2:' + m.payload.n),
  });
  await mq.messaging.publish({ topic: 'work', payload: { n: 1 } });
  await mq.messaging.publish({ topic: 'work', payload: { n: 2 } });
  assert.deepEqual(got, ['s1:1', 's2:2']); // exactly one consumer per message, alternating
});

// ── routing: broadcast ──────────────────────────────────────────────────────────

test('routing: broadcast reaches every subscriber regardless of group', async () => {
  const clock = makeClock();
  const mq = createMessagingPlatform({ clock });
  let n = 0;
  mq.messaging.subscribe({ topic: 'sys', group: 'g1', handler: () => (n += 1) });
  mq.messaging.subscribe({ topic: 'sys', group: 'g1', handler: () => (n += 1) });
  mq.messaging.subscribe({ topic: 'sys', group: 'g2', handler: () => (n += 1) });
  const r = await mq.messaging.broadcast({ topic: 'sys', payload: {} });
  assert.equal(r.delivered, 3);
  assert.equal(n, 3);
});

// ── routing: request/reply ──────────────────────────────────────────────────────

test('routing: request/reply resolves with the reply payload', async () => {
  const clock = makeClock();
  const mq = createMessagingPlatform({ clock });
  mq.messaging.subscribe({
    topic: 'rpc',
    handler: (m) => mq.messaging.reply(m, { echo: m.payload.v * 2 }),
  });
  const reply = await mq.messaging.request({ topic: 'rpc', payload: { v: 21 }, timeoutMs: 1000 });
  assert.deepEqual(reply, { echo: 42 });
});

test('routing: request with no subscriber rejects; request times out', async () => {
  const clock = makeClock();
  const mq = createMessagingPlatform({ clock });
  await assert.rejects(
    () => mq.messaging.request({ topic: 'void', payload: {} }),
    NoSubscriberError
  );
  // Subscriber that never replies → timeout.
  mq.messaging.subscribe({ topic: 'silent', handler: () => {} });
  await assert.rejects(
    () => mq.messaging.request({ topic: 'silent', payload: {}, timeoutMs: 20 }),
    RequestTimeoutError
  );
});

// ── retry ────────────────────────────────────────────────────────────────────

test('retry: a failing handler is retried then dead-lettered', async () => {
  const clock = makeClock();
  const pub = recordingPublisher();
  const mq = createMessagingPlatform({ clock, publisher: pub });
  let calls = 0;
  mq.messaging.subscribe({
    topic: 'flaky',
    group: 'f',
    handler: () => {
      calls += 1;
      throw new Error('boom');
    },
  });
  const r = await mq.messaging.publish({
    topic: 'flaky',
    payload: {},
    retryPolicy: { maxAttempts: 2, delayMs: 0 },
  });
  assert.equal(calls, 3); // 1 initial + 2 retries
  assert.equal(r.delivered, 0);
  assert.equal(mq.messaging.deadLetters().length, 1);
  assert.ok(pub.events.some((e) => e.type === 'MessageRetried'));
  assert.ok(pub.events.some((e) => e.type === 'DeadLettered'));
});

test('retry: handler that recovers before exhaustion is delivered', async () => {
  const clock = makeClock();
  const mq = createMessagingPlatform({ clock });
  let calls = 0;
  mq.messaging.subscribe({
    topic: 'recovers',
    group: 'r',
    handler: () => {
      calls += 1;
      if (calls < 2) throw new Error('transient');
    },
  });
  const r = await mq.messaging.publish({
    topic: 'recovers',
    payload: {},
    retryPolicy: { maxAttempts: 3, delayMs: 0 },
  });
  assert.equal(r.delivered, 1);
  assert.equal(mq.messaging.deadLetters().length, 0);
});

// ── TTL ────────────────────────────────────────────────────────────────────────

test('ttl: an expired message is not delivered; MessageExpired emitted', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const mq = createMessagingPlatform({ clock, publisher: pub });
  let got = 0;
  mq.messaging.subscribe({ topic: 'perishable', handler: () => (got += 1) });
  // A message whose absolute expiry is already in the past at delivery time.
  const r = await mq.messaging.publish({ topic: 'perishable', payload: {}, expiresAt: 500 });
  assert.equal(got, 0);
  assert.equal(r.expired, true);
  assert.ok(pub.events.some((e) => e.type === 'MessageExpired'));
});

// ── unsubscribe ──────────────────────────────────────────────────────────────

test('subscribe/unsubscribe lifecycle + events', async () => {
  const clock = makeClock();
  const pub = recordingPublisher();
  const mq = createMessagingPlatform({ clock, publisher: pub });
  let got = 0;
  const sub = mq.messaging.subscribe({ topic: 't', handler: () => (got += 1) });
  await mq.messaging.publish({ topic: 't', payload: {} });
  assert.equal(sub.unsubscribe(), true);
  await mq.messaging.publish({ topic: 't', payload: {} });
  assert.equal(got, 1); // no delivery after unsubscribe
  assert.ok(pub.events.some((e) => e.type === 'SubscriberRegistered'));
  assert.ok(pub.events.some((e) => e.type === 'SubscriberRemoved'));
});

// ── concurrency ──────────────────────────────────────────────────────────────

test('concurrency: competing consumers split N messages without loss/duplication', async () => {
  const clock = makeClock();
  const mq = createMessagingPlatform({ clock });
  const seen = new Set();
  let total = 0;
  for (let i = 0; i < 3; i++) {
    mq.messaging.subscribe({
      topic: 'q',
      group: 'workers',
      handler: (m) => {
        seen.add(m.payload.n);
        total += 1;
      },
    });
  }
  await Promise.all(
    Array.from({ length: 30 }, (_, n) => mq.messaging.publish({ topic: 'q', payload: { n } }))
  );
  assert.equal(total, 30); // each message handled exactly once
  assert.equal(seen.size, 30); // no duplicates
});

// ── SDK adapter: topic isolation + capability gates ─────────────────────────────

test('messaging SDK adapter: topic isolation + capability enforcement', async () => {
  const clock = makeClock();
  const mq = createMessagingPlatform({ clock });
  const portA = toMessagingPort(mq.messaging, { owner: 'ext-a' });
  const portB = toMessagingPort(mq.messaging, { owner: 'ext-b' });
  const aGot = [];
  portA.subscribe({ topic: 'chan', handler: (m) => aGot.push(m.payload) });
  // B publishes to "chan" — but it's namespaced to ext-b, so A must NOT receive it.
  await portB.publish({ topic: 'chan', payload: { from: 'b' } });
  assert.equal(aGot.length, 0);
  // A publishes to its own namespace → A receives.
  await portA.publish({ topic: 'chan', payload: { from: 'a' } });
  assert.deepEqual(aGot, [{ from: 'a' }]);

  const readonly = toMessagingPort(mq.messaging, { owner: 'ext-c', canPublish: false });
  await assert.rejects(
    async () => readonly.publish({ topic: 'x', payload: {} }),
    /messaging:publish/
  );
});

// ── failure injection ──────────────────────────────────────────────────────────

test('failure injection: one throwing subscriber does not stop others (pub/sub)', async () => {
  const clock = makeClock();
  const mq = createMessagingPlatform({ clock });
  let good = 0;
  mq.messaging.subscribe({
    topic: 't',
    group: 'bad',
    handler: () => {
      throw new Error('x');
    },
  });
  mq.messaging.subscribe({ topic: 't', group: 'good', handler: () => (good += 1) });
  const r = await mq.messaging.publish({ topic: 't', payload: {} });
  assert.equal(good, 1); // healthy subscriber still delivered
  assert.equal(r.failed, 1);
  assert.equal(mq.messaging.deadLetters().length, 1); // bad one dead-lettered
});

// ── stress ─────────────────────────────────────────────────────────────────────

test('stress: 2000 pub/sub messages delivered', async () => {
  const clock = makeClock();
  const mq = createMessagingPlatform({ clock });
  let n = 0;
  mq.messaging.subscribe({ topic: 'bulk', handler: () => (n += 1) });
  for (let i = 0; i < 2000; i++) await mq.messaging.publish({ topic: 'bulk', payload: { i } });
  assert.equal(n, 2000);
  assert.equal(mq.messaging.metrics().delivered, 2000);
});
