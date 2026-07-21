'use strict';

/**
 * Enterprise Background Jobs Kernel tests (Phase 15.3 / ADR-032) — covers every
 * required category: unit (job value object, retry policy, checksum), queue
 * (priority + FIFO ordering), scheduling, retry, dead-letter, provider (+ future
 * extension points), concurrency, stress, failure injection, and performance, plus
 * events-via-port and the SDK owner-scoped adapter (namespace isolation + capability
 * gates). Deterministic: clock injected, tick-driven execution.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createJob, fromModel, computeChecksum, STATUS } = require('../../src/domain/jobs/job');
const { createRetryPolicy } = require('../../src/domain/jobs/retryPolicy');
const { createJobsPlatform, providers } = require('../../src/application/jobs');
const { createJobsMetrics } = require('../../src/application/jobs/metrics');
const { toJobsPort } = require('../../src/application/jobs/sdkAdapter');
const { JobValidationError, HandlerError } = require('../../src/domain/jobs/errors');

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
  const jk = createJobsPlatform({ clock, publisher: pub, ...extra });
  return { jk, J: jk.jobs, pub };
}

// ── domain: job value object + checksum ──────────────────────────────────────────

test('job: create, checksum, status transitions, model round-trip', () => {
  const clock = makeClock(1000);
  const j = createJob({ type: 'email', payload: { to: 'a' }, maxAttempts: 3 }, { clock });
  assert.equal(j.status, STATUS.CREATED);
  assert.equal(j.maxAttempts, 3);
  assert.ok(j.checksum && j.checksum.length === 64);
  assert.ok(j.verifyChecksum());
  j.markQueued(1050);
  j.markRunning(1100);
  assert.equal(j.attemptCount, 1);
  j.markCompleted(1200);
  assert.equal(j.status, STATUS.COMPLETED);
  const re = fromModel(j.toModel(), { clock });
  assert.equal(re.status, STATUS.COMPLETED);
  assert.ok(re.verifyChecksum());
  assert.throws(() => createJob({}), JobValidationError); // no type
  assert.throws(() => createJob({ type: 't', payload: () => 1 }), JobValidationError); // fn payload
});

test('retryPolicy: validation + deterministic backoff', () => {
  assert.throws(() => createRetryPolicy({ maxAttempts: 0 }), JobValidationError);
  const p = createRetryPolicy({ maxAttempts: 4, backoffMs: 100, factor: 2, maxBackoffMs: 300 });
  assert.equal(p.shouldRetry(1), true);
  assert.equal(p.shouldRetry(4), false);
  assert.equal(p.nextDelayMs(1), 100);
  assert.equal(p.nextDelayMs(3), 300); // capped
});

// ── unit: metrics ─────────────────────────────────────────────────────────────────

test('metrics: counters + gauges + prometheus', () => {
  const m = createJobsMetrics({ clock: () => 0 });
  m.bindGauges({ registered: () => 2, queued: () => 3, running: () => 1, deadLetter: () => 0 });
  m.recordEnqueued();
  m.recordCompleted();
  m.recordRetried();
  const s = m.snapshot();
  assert.equal(s.registeredJobs, 2);
  assert.equal(s.queuedJobs, 3);
  assert.equal(s.completed, 1);
  assert.match(m.prometheus(), /jobs_completed_total 1/);
  assert.match(m.prometheus(), /jobs_queued 3/);
});

// ── provider + future extension points ───────────────────────────────────────────

test('provider: memory persists jobs; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.putJob('n', { jobId: 'j1', type: 't', status: 'queued' });
  assert.equal((await mem.getJob('n', 'j1')).type, 't');
  assert.equal((await mem.listJobs('n')).length, 1);
  assert.equal(await mem.removeJob('n', 'j1'), true);
  assert.ok(providers.FUTURE_PROVIDERS.includes('redis'));
  assert.ok(providers.FUTURE_PROVIDERS.includes('message-queue'));
  const p = providers.futureProvider('postgresql');
  assert.equal(p.planned, true);
  assert.throws(() => p.putJob('n', {}), /extension point/);
});

// ── enqueue + execute + events ─────────────────────────────────────────────────────

test('jobs: register + enqueue + tick runs the handler to completion; events', async () => {
  const clock = makeClock(1000);
  const { J, pub } = platform(clock);
  const seen = [];
  J.register({ type: 'greet', handler: async (payload) => seen.push(payload.name) });
  const job = await J.enqueue({ type: 'greet', payload: { name: 'Sam' } });
  assert.equal(job.status, STATUS.QUEUED);
  const sum = await J.tick(1000);
  assert.equal(sum.completed, 1);
  assert.deepEqual(seen, ['Sam']);
  assert.equal((await J.status({ jobId: job.jobId })).status, STATUS.COMPLETED);
  const types = pub.events.map((e) => e.type);
  assert.ok(
    types.includes('JobRegistered') &&
      types.includes('JobQueued') &&
      types.includes('JobStarted') &&
      types.includes('JobCompleted')
  );
  assert.ok(pub.events.every((e) => e.producer === 'jobs'));
  await assert.rejects(() => J.enqueue({ type: 'unknown' }), HandlerError);
});

// ── queue ordering (priority then FIFO) ────────────────────────────────────────────

test('jobs: tick runs due jobs in priority-then-FIFO order (deterministic)', async () => {
  const clock = makeClock(1000);
  const { J } = platform(clock);
  const order = [];
  J.register({ type: 't', handler: async (p) => order.push(p.id) });
  await J.enqueue({ type: 't', payload: { id: 'a' }, priority: 1 });
  await J.enqueue({ type: 't', payload: { id: 'b' }, priority: 5 });
  await J.enqueue({ type: 't', payload: { id: 'c' }, priority: 5 });
  await J.tick(1000);
  assert.deepEqual(order, ['b', 'c', 'a']); // priority 5 (b before c by FIFO), then priority 1
});

// ── scheduling ────────────────────────────────────────────────────────────────────

test('jobs: scheduled job runs only when due', async () => {
  const clock = makeClock(1000);
  const { J, pub } = platform(clock);
  let ran = false;
  J.register({ type: 't', handler: async () => (ran = true) });
  const job = await J.schedule({ type: 't', payload: {}, scheduledTime: 2000 });
  assert.equal(job.status, STATUS.SCHEDULED);
  assert.equal((await J.tick(1500)).processed, 0);
  assert.equal(ran, false);
  await J.tick(2000);
  assert.equal(ran, true);
  assert.ok(pub.events.some((e) => e.type === 'JobQueued' && e.payload.scheduledTime === 2000));
});

// ── retry ──────────────────────────────────────────────────────────────────────────

test('jobs: transient failures retry with backoff then succeed', async () => {
  const clock = makeClock(1000);
  const { J, jk } = platform(clock);
  let attempts = 0;
  J.register({
    type: 'flaky',
    handler: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
    },
  });
  const job = await J.enqueue({
    type: 'flaky',
    payload: {},
    retryPolicy: { maxAttempts: 3, backoffMs: 100, factor: 2 },
  });
  await J.tick(1000); // attempt 1 fails → retry at 1100
  assert.equal((await J.status({ jobId: job.jobId })).status, STATUS.RETRYING);
  clock.set(1100);
  await J.tick(1100); // attempt 2 fails → retry at 1300
  clock.set(1300);
  const sum = await J.tick(1300); // attempt 3 succeeds
  assert.equal(sum.completed, 1);
  const final = await J.status({ jobId: job.jobId });
  assert.equal(final.status, STATUS.COMPLETED);
  assert.equal(final.attemptCount, 3);
  assert.ok(jk.metrics.snapshot().retried >= 2);
});

// ── dead-letter ─────────────────────────────────────────────────────────────────

test('jobs: exhausted retries land in the dead-letter queue', async () => {
  const clock = makeClock(1000);
  const { J, jk } = platform(clock);
  J.register({
    type: 'always-fails',
    handler: async () => {
      throw new Error('nope');
    },
  });
  const job = await J.enqueue({
    type: 'always-fails',
    payload: {},
    retryPolicy: { maxAttempts: 2, backoffMs: 10 },
  });
  await J.tick(1000); // attempt 1 → retry
  clock.set(1100);
  await J.tick(1100); // attempt 2 → dead-letter
  const final = await J.status({ jobId: job.jobId });
  assert.equal(final.status, STATUS.DEAD_LETTER);
  assert.equal(final.deadLettered, true);
  assert.equal((await J.deadLetters()).length, 1);
  assert.equal(jk.metrics.snapshot().deadLetterJobs, 1);
});

// ── timeout detection ────────────────────────────────────────────────────────────

test('jobs: a handler exceeding its timeout is treated as a failure', async () => {
  const clock = makeClock(1000);
  const { J } = platform(clock);
  // handler advances the injected clock past the timeout budget
  J.register({
    type: 'slow',
    handler: async () => {
      clock.set(clock() + 5000);
    },
  });
  const job = await J.enqueue({
    type: 'slow',
    payload: {},
    timeout: 1000,
    retryPolicy: { maxAttempts: 1 },
  });
  await J.tick(1000);
  const final = await J.status({ jobId: job.jobId });
  assert.equal(final.status, STATUS.DEAD_LETTER); // timed out + no retries
  assert.equal(final.lastError, 'timeout');
});

// ── cancellation ────────────────────────────────────────────────────────────────

test('jobs: cancel a queued/scheduled job', async () => {
  const clock = makeClock();
  const { J, pub } = platform(clock);
  J.register({ type: 't', handler: async () => {} });
  const job = await J.schedule({ type: 't', payload: {}, delayMs: 5000 });
  assert.equal(await J.cancel({ jobId: job.jobId }), true);
  assert.equal((await J.status({ jobId: job.jobId })).status, STATUS.CANCELLED);
  assert.equal(await J.cancel({ jobId: job.jobId }), false); // terminal
  assert.equal(await J.cancel({ jobId: 'ghost' }), false);
  assert.ok(pub.events.some((e) => e.type === 'JobCancelled'));
});

// ── deduplication + idempotency ───────────────────────────────────────────────────

test('jobs: duplicate enqueue (same dedupKey, live) is collapsed', async () => {
  const clock = makeClock();
  const { J, jk } = platform(clock);
  J.register({ type: 't', handler: async () => {} });
  const a = await J.enqueue({ type: 't', payload: {}, dedupKey: 'k1' });
  const b = await J.enqueue({ type: 't', payload: {}, dedupKey: 'k1' });
  assert.equal(a.jobId, b.jobId);
  assert.ok(jk.metrics.snapshot().duplicates >= 1);
});

test('jobs: idempotency short-circuits a completed key', async () => {
  const clock = makeClock(1000);
  const { J } = platform(clock);
  let runs = 0;
  J.register({ type: 't', handler: async () => (runs += 1) });
  const a = await J.enqueue({ type: 't', payload: {}, idempotencyKey: 'idem-1' });
  await J.tick(1000);
  assert.equal(runs, 1);
  const b = await J.enqueue({ type: 't', payload: {}, idempotencyKey: 'idem-1' }); // already completed
  assert.equal(b.jobId, a.jobId);
  await J.tick(1000);
  assert.equal(runs, 1); // not run again
});

// ── integrity / verify ────────────────────────────────────────────────────────────

test('jobs: verify detects a tampered stored job', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const { J } = platform(clock, { provider });
  J.register({ type: 't', handler: async () => {} });
  const job = await J.enqueue({ type: 't', payload: { v: 1 } });
  assert.equal((await J.verify({ namespace: 'default' })).ok, true);
  const stored = await provider.getJob('default', job.jobId);
  await provider.putJob('default', { ...stored, payload: { v: 'HIJACKED' } });
  const v = await J.verify({ namespace: 'default' });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.jobId === job.jobId));
});

// ── SDK adapter: namespace isolation + capability gates ──────────────────────────

test('sdk: owner-scoped port isolates namespaces + gates + no handler registration', async () => {
  const clock = makeClock(1000);
  const { J } = platform(clock);
  J.register({ type: 't', handler: async () => {} }); // handlers are shared infra (admin)
  const alice = toJobsPort(J, { owner: 'alice' });
  const bob = toJobsPort(J, { owner: 'bob' });
  const a = await alice.enqueue({ type: 't', payload: {} });
  await bob.enqueue({ type: 't', payload: {} });
  assert.ok(await alice.status({ jobId: a.jobId }));
  assert.equal(await bob.status({ jobId: a.jobId }), null); // isolated
  assert.equal(typeof alice.register, 'undefined'); // no handler registration
  const noEnq = toJobsPort(J, { owner: 'x', canEnqueue: false });
  await assert.rejects(async () => noEnq.enqueue({ type: 't' }), /jobs:enqueue/);
  const noRead = toJobsPort(J, { owner: 'y', canRead: false });
  await assert.rejects(async () => noRead.status({ jobId: 'z' }), /jobs:read/);
  assert.throws(() => toJobsPort(J, {}), /owner required/);
});

// ── failure injection ──────────────────────────────────────────────────────────

test('jobs: provider failures are counted and surfaced', async () => {
  const clock = makeClock();
  const failing = {
    name: 'failing',
    putJob: () => Promise.reject(new Error('db down')),
    getJob: () => Promise.resolve(null),
    listJobs: () => Promise.resolve([]),
    removeJob: () => Promise.resolve(false),
    health: () => ({ ok: false }),
  };
  const { J, jk } = platform(clock, { provider: failing });
  J.register({ type: 't', handler: async () => {} });
  await assert.rejects(() => J.enqueue({ type: 't', payload: {} }), /db down/);
  assert.ok(jk.metrics.snapshot().providerFailures >= 1);
  assert.equal((await J.health()).ok, false);
});

// ── concurrency ─────────────────────────────────────────────────────────────────

test('jobs: concurrent enqueues are isolated + each runs exactly once', async () => {
  const clock = makeClock(1000);
  const { J } = platform(clock);
  let runs = 0;
  J.register({ type: 't', handler: async () => (runs += 1) });
  const jobs = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      J.enqueue({ type: 't', payload: { i }, dedupKey: 'd' + i })
    )
  );
  assert.equal(new Set(jobs.map((j) => j.jobId)).size, 25);
  await J.tick(1000);
  await J.tick(1000); // second tick must not re-run completed jobs
  assert.equal(runs, 25);
});

// ── stress / performance ──────────────────────────────────────────────────────────

test('jobs: stress — 1000 jobs execute once each, fast + consistent', async () => {
  const clock = makeClock(1000);
  const { J, jk } = platform(clock);
  let runs = 0;
  J.register({ type: 't', handler: async () => (runs += 1) });
  for (let i = 0; i < 1000; i++) await J.enqueue({ type: 't', payload: { i }, dedupKey: 'k' + i });
  const start = Date.now();
  const sum = await J.tick(1000);
  const elapsed = Date.now() - start;
  assert.equal(sum.completed, 1000);
  assert.equal(runs, 1000);
  assert.ok(elapsed < 3000, `expected < 3s, took ${elapsed}ms`);
  assert.equal(jk.metrics.snapshot().completed, 1000);
  assert.equal((await J.verify({ namespace: 'default' })).ok, true);
});

test('job checksum is stable across re-hydration', async () => {
  const clock = makeClock();
  const { J, jk } = platform(clock);
  J.register({ type: 't', handler: async () => {} });
  const job = await J.enqueue({ type: 't', payload: { a: 1 } });
  const model = await jk.provider.getJob('default', job.jobId);
  assert.equal(model.checksum, computeChecksum(fromModel(model)));
});
