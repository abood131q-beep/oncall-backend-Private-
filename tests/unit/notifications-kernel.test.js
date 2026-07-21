'use strict';

/**
 * Enterprise Notification Kernel tests (Phase 15.1 / ADR-030) — covers every
 * required category: unit (notification value object, retry policy, template),
 * delivery, retry, scheduling, deduplication, provider (+ future extension points),
 * concurrency, stress, and failure injection, plus events-via-port and the SDK
 * owner-scoped adapter (namespace isolation + capability gates). Deterministic:
 * clock injected, tick-driven scheduling. This is the NEW Notification KERNEL
 * (src/…/notifications-kernel), distinct from the app's notifications context.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createNotification,
  fromModel,
  STATUS,
} = require('../../src/domain/notifications-kernel/notification');
const { createRetryPolicy } = require('../../src/domain/notifications-kernel/retryPolicy');
const { render, resolveContent } = require('../../src/domain/notifications-kernel/template');
const {
  createNotificationPlatform,
  providers,
} = require('../../src/application/notifications-kernel');
const { createNotificationMetrics } = require('../../src/application/notifications-kernel/metrics');
const { createMemoryStore } = require('../../src/application/notifications-kernel/store');
const { toNotificationPort } = require('../../src/application/notifications-kernel/sdkAdapter');
const {
  NotificationValidationError,
  ChannelError,
} = require('../../src/domain/notifications-kernel/errors');

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
function platform(clock, extra = {}) {
  const pub = recordingPublisher();
  const nk = createNotificationPlatform({ clock, publisher: pub, ...extra });
  return { nk, N: nk.notifications, pub };
}

// ── domain: notification value object + checksum ──────────────────────────────────

test('notification: create, checksum, status transitions, model round-trip', () => {
  const clock = makeClock(1000);
  const n = createNotification({ channel: 'push', recipient: 'u1', title: 'Hi' }, { clock });
  assert.equal(n.status, STATUS.CREATED);
  assert.ok(n.checksum && n.checksum.length === 64);
  assert.ok(n.verifyChecksum());
  n.markSent(1100);
  n.markDelivered('p-1', 1200);
  assert.equal(n.status, STATUS.DELIVERED);
  assert.equal(n.deliveries.length, 1);
  const re = fromModel(n.toModel(), { clock });
  assert.equal(re.status, STATUS.DELIVERED);
  assert.ok(re.verifyChecksum());
  assert.throws(() => createNotification({ recipient: 'u1' }), NotificationValidationError); // no channel
  assert.throws(() => createNotification({ channel: 'push' }), NotificationValidationError); // no recipient
});

test('retryPolicy: validation + deterministic backoff', () => {
  assert.throws(() => createRetryPolicy({ maxAttempts: 0 }), NotificationValidationError);
  const p = createRetryPolicy({ maxAttempts: 3, backoffMs: 100, factor: 2, maxBackoffMs: 300 });
  assert.equal(p.shouldRetry(1), true);
  assert.equal(p.shouldRetry(3), false);
  assert.equal(p.nextDelayMs(1), 100);
  assert.equal(p.nextDelayMs(2), 200);
  assert.equal(p.nextDelayMs(3), 300); // capped
});

test('template: deterministic placeholder rendering', () => {
  assert.equal(
    render('Hi {{name}}, ride {{trip.id}}', { name: 'Sam', trip: { id: 'T7' } }),
    'Hi Sam, ride T7'
  );
  assert.equal(render('{{missing}} ok', {}), ' ok'); // unknown → empty, never throws
  const c = resolveContent({ title: '{{t}}', body: 'Body {{b}}' }, { t: 'Title', b: 'X' });
  assert.deepEqual([c.title, c.body], ['Title', 'Body X']);
});

// ── unit: metrics ─────────────────────────────────────────────────────────────────

test('metrics: counters + scheduled gauge + prometheus', () => {
  const m = createNotificationMetrics({ clock: () => 0 });
  m.bindGauges({ scheduled: () => 4 });
  m.recordCreated();
  m.recordSent();
  m.recordDelivery();
  m.recordRetry();
  const s = m.snapshot();
  assert.equal(s.created, 1);
  assert.equal(s.deliveries, 1);
  assert.equal(s.retries, 1);
  assert.equal(s.scheduled, 4);
  assert.match(m.prometheus(), /notifications_deliveries_total 1/);
  assert.match(m.prometheus(), /notifications_scheduled 4/);
});

// ── provider + future extension points ───────────────────────────────────────────

test('provider: memory delivers + records; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  const r = await mem.deliver({ notificationId: 'n1', channel: 'push', recipient: 'u1' });
  assert.equal(r.ok, true);
  assert.equal(mem.deliveries.length, 1);
  assert.equal(mem.supports('anything'), true);
  assert.ok(providers.FUTURE_PROVIDERS.includes('fcm'));
  assert.ok(providers.FUTURE_PROVIDERS.includes('twilio'));
  const p = providers.futureProvider('apns');
  assert.equal(p.planned, true);
  assert.equal(p.supports('push'), false);
  assert.throws(() => p.deliver({}), /extension point/);
});

// ── delivery ────────────────────────────────────────────────────────────────────

test('notifications: registerChannel + send → sent + delivered; events + channel error', async () => {
  const clock = makeClock(1000);
  const { N, pub } = platform(clock);
  const mem = providers.createMemoryProvider();
  N.registerChannel({ channel: 'push', provider: mem });
  const model = await N.send({
    channel: 'push',
    recipient: 'u1',
    title: 'Hi',
    body: 'Ride {{eta}} min',
    data: { eta: 5 },
  });
  assert.equal(model.status, STATUS.DELIVERED);
  assert.equal(model.body, 'Ride 5 min'); // template resolved
  assert.equal(mem.deliveries.length, 1);
  const types = pub.events.map((e) => e.type);
  assert.ok(
    types.includes('NotificationCreated') &&
      types.includes('NotificationSent') &&
      types.includes('NotificationDelivered')
  );
  assert.ok(pub.events.every((e) => e.producer === 'notifications'));
  // unknown channel → failed with ChannelError reason (send itself resolves)
  const bad = await N.send({ channel: 'sms', recipient: 'u1', body: 'x' });
  assert.equal(bad.status, STATUS.FAILED);
  assert.throws(() => N.registerChannel({ provider: mem }), NotificationValidationError);
  assert.throws(() => {
    const svc = createNotificationPlatform({ clock }).notifications;
    return svc.registerChannel({ channel: 'c', provider: { name: 'incomplete' } });
  }, /must implement/);
});

test('notifications: status + cancel', async () => {
  const clock = makeClock();
  const { N } = platform(clock);
  N.registerChannel({ channel: 'push', provider: providers.createMemoryProvider() });
  const s = await N.schedule({ channel: 'push', recipient: 'u1', body: 'later', delayMs: 1000 });
  assert.equal(s.status, STATUS.SCHEDULED);
  const got = await N.status({ notificationId: s.notificationId });
  assert.equal(got.status, STATUS.SCHEDULED);
  assert.equal(await N.cancel({ notificationId: s.notificationId }), true);
  assert.equal((await N.status({ notificationId: s.notificationId })).status, STATUS.CANCELLED);
  assert.equal(await N.cancel({ notificationId: s.notificationId }), false); // terminal
  assert.equal(await N.status({ notificationId: 'nope' }), null);
});

// ── scheduling ────────────────────────────────────────────────────────────────────

test('notifications: scheduled delivery fires only when due (tick-driven)', async () => {
  const clock = makeClock(1000);
  const { N, pub } = platform(clock);
  const mem = providers.createMemoryProvider();
  N.registerChannel({ channel: 'push', provider: mem });
  const s = await N.schedule({ channel: 'push', recipient: 'u1', body: 'x', scheduledTime: 2000 });
  // not due yet
  let sum = await N.tick(1500);
  assert.equal(sum.processed, 0);
  assert.equal((await N.status({ notificationId: s.notificationId })).status, STATUS.SCHEDULED);
  // due now
  sum = await N.tick(2000);
  assert.equal(sum.processed, 1);
  assert.equal(sum.delivered, 1);
  assert.equal((await N.status({ notificationId: s.notificationId })).status, STATUS.DELIVERED);
  assert.ok(pub.events.some((e) => e.type === 'NotificationScheduled'));
});

test('notifications: expired scheduled notification is not delivered', async () => {
  const clock = makeClock(1000);
  const { N } = platform(clock);
  const mem = providers.createMemoryProvider();
  N.registerChannel({ channel: 'push', provider: mem });
  const s = await N.schedule({
    channel: 'push',
    recipient: 'u1',
    body: 'x',
    scheduledTime: 2000,
    expirationTime: 1500,
  });
  const sum = await N.tick(2000); // due, but already past expiration
  assert.equal(sum.expired, 1);
  assert.equal((await N.status({ notificationId: s.notificationId })).status, STATUS.EXPIRED);
  assert.equal(mem.deliveries.length, 0);
});

// ── retry ──────────────────────────────────────────────────────────────────────────

test('notifications: transient failures retry then succeed (deterministic backoff)', async () => {
  const clock = makeClock(1000);
  const { N, nk } = platform(clock);
  const mem = providers.createMemoryProvider({ failTimes: 2 }); // first 2 attempts fail
  N.registerChannel({ channel: 'push', provider: mem });
  const model = await N.send({
    channel: 'push',
    recipient: 'u1',
    body: 'x',
    retryPolicy: { maxAttempts: 3, backoffMs: 100, factor: 2 },
  });
  assert.equal(model.status, STATUS.SCHEDULED); // first attempt failed → retry scheduled
  assert.equal(model.attempts, 1);
  clock.set(1100);
  await N.tick(1100); // 2nd attempt fails → retry
  clock.set(1400);
  const sum = await N.tick(1400); // 3rd attempt succeeds
  assert.equal(sum.delivered, 1);
  const final = await N.status({ notificationId: model.notificationId });
  assert.equal(final.status, STATUS.DELIVERED);
  assert.equal(final.attempts, 3);
  assert.ok(nk.metrics.snapshot().retries >= 2);
});

test('notifications: exhausted retries end in failed', async () => {
  const clock = makeClock(1000);
  const { N } = platform(clock);
  N.registerChannel({ channel: 'push', provider: providers.createMemoryProvider({ fail: true }) });
  const model = await N.send({
    channel: 'push',
    recipient: 'u1',
    body: 'x',
    retryPolicy: { maxAttempts: 2, backoffMs: 10 },
  });
  clock.set(1100);
  await N.tick(1100);
  const final = await N.status({ notificationId: model.notificationId });
  assert.equal(final.status, STATUS.FAILED);
  assert.equal(final.attempts, 2);
});

// ── deduplication ───────────────────────────────────────────────────────────────

test('notifications: duplicate send is deduplicated (same dedupKey, non-terminal)', async () => {
  const clock = makeClock(1000);
  const { N, nk } = platform(clock);
  // provider that never confirms so the first stays non-terminal (scheduled)
  N.registerChannel({
    channel: 'push',
    provider: providers.createMemoryProvider({ failTimes: 1 }),
  });
  const a = await N.send({
    channel: 'push',
    recipient: 'u1',
    body: 'x',
    dedupKey: 'k1',
    retryPolicy: { maxAttempts: 5, backoffMs: 100 },
  });
  const b = await N.send({ channel: 'push', recipient: 'u1', body: 'y', dedupKey: 'k1' });
  assert.equal(a.notificationId, b.notificationId); // deduped → same record
  assert.ok(nk.metrics.snapshot().duplicates >= 1);
});

// ── integrity / verify ────────────────────────────────────────────────────────────

test('notifications: verify detects a tampered stored notification', async () => {
  const clock = makeClock();
  const store = createMemoryStore();
  const { N } = platform(clock, { store });
  N.registerChannel({ channel: 'push', provider: providers.createMemoryProvider() });
  const s = await N.schedule({ channel: 'push', recipient: 'u1', body: 'x', delayMs: 5000 });
  assert.equal((await N.verify({ namespace: 'default' })).ok, true);
  // tamper directly in the store, leaving the checksum stale
  const stored = await store.get('default', s.notificationId);
  await store.put('default', { ...stored, recipient: 'attacker' });
  const v = await N.verify({ namespace: 'default' });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.notificationId === s.notificationId));
});

// ── SDK adapter: namespace isolation + capability gates ──────────────────────────

test('sdk: owner-scoped port isolates namespaces + gates + no channel registration', async () => {
  const clock = makeClock();
  const { N, nk } = platform(clock);
  // Channels are shared infra registered on the engine (admin side).
  N.registerChannel({ channel: 'push', provider: providers.createMemoryProvider() });
  const alice = toNotificationPort(N, { owner: 'alice' });
  const bob = toNotificationPort(N, { owner: 'bob' });
  const a = await alice.send({ channel: 'push', recipient: 'a', body: 'hi' });
  await bob.send({ channel: 'push', recipient: 'b', body: 'hi' });
  // alice can only see her own namespace
  assert.ok(await alice.status({ notificationId: a.notificationId }));
  assert.equal(await bob.status({ notificationId: a.notificationId }), null);
  assert.equal(typeof alice.registerChannel, 'undefined'); // no channel wiring
  const noSend = toNotificationPort(N, { owner: 'x', canSend: false });
  await assert.rejects(
    async () => noSend.send({ channel: 'push', recipient: 'u', body: 'x' }),
    /notification:send/
  );
  const noRead = toNotificationPort(N, { owner: 'y', canRead: false });
  await assert.rejects(async () => noRead.status({ notificationId: 'z' }), /notification:read/);
  assert.throws(() => toNotificationPort(N, {}), /owner required/);
  void nk;
});

// ── failure injection ───────────────────────────────────────────────────────────

test('notifications: provider throw is counted + surfaces as failed (no retry)', async () => {
  const clock = makeClock();
  const { N, nk } = platform(clock);
  const throwing = {
    name: 'throwing',
    supports: () => true,
    deliver: () => Promise.reject(new Error('socket reset')),
    health: () => ({ ok: false }),
  };
  N.registerChannel({ channel: 'push', provider: throwing });
  const model = await N.send({ channel: 'push', recipient: 'u1', body: 'x' }); // maxAttempts default 1
  assert.equal(model.status, STATUS.FAILED);
  assert.ok(nk.metrics.snapshot().providerFailures >= 1);
  assert.equal((await N.health()).ok, false);
});

// ── concurrency ─────────────────────────────────────────────────────────────────

test('notifications: concurrent sends are isolated + independently tracked', async () => {
  const clock = makeClock();
  const { N } = platform(clock);
  N.registerChannel({ channel: 'push', provider: providers.createMemoryProvider() });
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      N.send({ channel: 'push', recipient: 'u' + i, body: 'x', dedupKey: 'd' + i })
    )
  );
  assert.equal(results.length, 20);
  assert.ok(results.every((r) => r.status === STATUS.DELIVERED));
  assert.equal(new Set(results.map((r) => r.notificationId)).size, 20); // all distinct
});

// ── stress ──────────────────────────────────────────────────────────────────────

test('notifications: stress — 500 sends deliver + verify consistent', async () => {
  const clock = makeClock();
  const { N, nk } = platform(clock);
  const mem = providers.createMemoryProvider();
  N.registerChannel({ channel: 'push', provider: mem });
  for (let i = 0; i < 500; i++) {
    await N.send({ channel: 'push', recipient: 'u' + i, body: 'x', dedupKey: 'k' + i });
  }
  assert.equal(nk.metrics.snapshot().deliveries, 500);
  assert.equal(mem.deliveries.length, 500);
  assert.equal((await N.verify({ namespace: 'default' })).ok, true);
  assert.equal((await N.list()).length, 500);
});
