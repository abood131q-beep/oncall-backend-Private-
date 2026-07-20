'use strict';

/**
 * Enterprise Scheduler tests (Phase 14.3.3) — covers every required category:
 * unit (cron, retryPolicy, job, schedule), concurrency, retry, timeout, stress,
 * failure injection, performance, recovery, plus events-via-port, observability,
 * and the SDK owner-scoped adapter (ownership + capability enforcement).
 * Deterministic: time is injected and work advanced via tick().
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const cron = require('../../src/domain/scheduler/cron');
const retryPolicy = require('../../src/domain/scheduler/retryPolicy');
const { createJob, STATUS } = require('../../src/domain/scheduler/job');
const { createSchedulerPlatform } = require('../../src/application/scheduler');
const { toSchedulerPort } = require('../../src/application/scheduler/sdkAdapter');

function recordingPublisher() {
  const events = [];
  return { events, publish: (e) => (events.push(e), Promise.resolve()) };
}
function makeClock(start = 1000) {
  const box = { now: start };
  const clock = () => box.now;
  clock.set = (n) => (box.now = n);
  return clock;
}

// ── domain unit: cron ──────────────────────────────────────────────────────────

test('cron: parses and computes next run deterministically (UTC)', () => {
  const from = Date.UTC(2026, 6, 20, 12, 0, 0); // 2026-07-20 12:00
  assert.equal(
    new Date(cron.nextAfter('0 0 * * *', from)).toISOString(),
    '2026-07-21T00:00:00.000Z'
  );
  assert.equal(
    new Date(cron.nextAfter('*/15 * * * *', from)).toISOString(),
    '2026-07-20T12:15:00.000Z'
  );
  assert.equal(
    new Date(cron.nextAfter('30 9 * * *', from)).toISOString(),
    '2026-07-21T09:30:00.000Z'
  );
  assert.ok(cron.isValid('0 0 * * *'));
  assert.ok(!cron.isValid('bad cron'));
  assert.ok(!cron.isValid('99 0 * * *'));
});

// ── domain unit: retry policy ────────────────────────────────────────────────

test('retryPolicy: none/fixed/exponential + max attempts', () => {
  assert.equal(retryPolicy.decide(retryPolicy.normalize({ type: 'none' }), 0).retry, false);
  const fixed = retryPolicy.normalize({ type: 'fixed', maxAttempts: 2, delayMs: 100 });
  assert.deepEqual(retryPolicy.decide(fixed, 0), { retry: true, delayMs: 100 });
  assert.equal(retryPolicy.decide(fixed, 2).retry, false); // exhausted
  const exp = retryPolicy.normalize({
    type: 'exponential',
    maxAttempts: 5,
    delayMs: 100,
    factor: 2,
    maxDelayMs: 500,
  });
  assert.equal(retryPolicy.decide(exp, 0).delayMs, 100);
  assert.equal(retryPolicy.decide(exp, 1).delayMs, 200);
  assert.equal(retryPolicy.decide(exp, 2).delayMs, 400);
  assert.equal(retryPolicy.decide(exp, 3).delayMs, 500); // clamped
});

// ── domain unit: job model + transitions ─────────────────────────────────────

test('job: model carries required fields and transitions', () => {
  const j = createJob(
    { name: 'j', owner: 'sys', priority: 'high', tags: ['a'] },
    { clock: () => 1000 }
  );
  const m = j.toModel();
  for (const f of [
    'jobId',
    'name',
    'owner',
    'priority',
    'createdAt',
    'scheduledAt',
    'nextRun',
    'lastRun',
    'status',
    'retryPolicy',
    'timeout',
    'metadata',
    'tags',
  ]) {
    assert.ok(f in m, `missing field ${f}`);
  }
  assert.equal(j.status, STATUS.SCHEDULED);
  assert.ok(j.isDue(1000));
  j.pause();
  assert.equal(j.status, STATUS.PAUSED);
  j.resume();
  assert.equal(j.status, STATUS.SCHEDULED);
  assert.throws(() => createJob({ name: 'x' }), /owner/);
});

// ── scheduling types + due semantics ──────────────────────────────────────────

test('scheduler: delayed job runs only once due; events via port', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const p = createSchedulerPlatform({ concurrency: 2, clock, publisher: pub });
  const ran = [];
  const id = p.scheduler.scheduleAfter(
    { name: 'x', owner: 'sys', handler: () => ran.push(1) },
    500
  );
  clock.set(1200);
  await p.scheduler.tick(1200); // nextRun 1500 → not due
  assert.equal(ran.length, 0);
  clock.set(1600);
  await p.scheduler.tick(1600);
  assert.equal(ran.length, 1);
  assert.equal(p.scheduler.status(id), STATUS.COMPLETED);
  const types = pub.events.map((e) => e.type);
  assert.ok(
    types.includes('JobScheduled') && types.includes('JobStarted') && types.includes('JobCompleted')
  );
  assert.ok(pub.events.every((e) => e.producer === 'scheduler'));
});

test('scheduler: recurring interval reschedules; cron computes next', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ clock });
  const cnt = [];
  const id = p.scheduler.scheduleRecurring(
    { name: 'r', owner: 'sys', handler: () => cnt.push(1) },
    { intervalMs: 100 }
  );
  clock.set(1100);
  await p.scheduler.tick(1100); // first occurrence at 1000+100
  clock.set(1200);
  await p.scheduler.tick(1200);
  assert.equal(cnt.length, 2);
  assert.equal(p.scheduler.status(id), STATUS.SCHEDULED); // still scheduled for next
});

// ── concurrency ────────────────────────────────────────────────────────────────

test('scheduler: concurrency limit caps simultaneous executions', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ concurrency: 2, clock });
  let inFlight = 0;
  let peak = 0;
  const gate = [];
  const handler = () =>
    new Promise((resolve) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      gate.push(() => {
        inFlight--;
        resolve();
      });
    });
  for (let i = 0; i < 6; i++) p.scheduler.schedule({ name: 'c' + i, owner: 'sys', handler });
  const tickP = p.scheduler.tick(1000);
  // Release gates over time so the pool must recycle workers.
  const release = setInterval(() => gate.length && gate.shift()(), 1);
  await tickP;
  clearInterval(release);
  assert.equal(peak, 2, `peak concurrency ${peak}`);
});

// ── retry ────────────────────────────────────────────────────────────────────

test('scheduler: retries with backoff then succeeds', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const p = createSchedulerPlatform({ clock, publisher: pub });
  let attempts = 0;
  const id = p.scheduler.schedule({
    name: 'flaky',
    owner: 'sys',
    retryPolicy: { type: 'fixed', maxAttempts: 3, delayMs: 100 },
    handler: () => {
      attempts++;
      if (attempts < 3) throw new Error('boom');
    },
  });
  await p.scheduler.tick(1000);
  assert.equal(p.scheduler.status(id), STATUS.RETRYING);
  clock.set(1100);
  await p.scheduler.tick(1100);
  clock.set(1200);
  await p.scheduler.tick(1200);
  assert.equal(attempts, 3);
  assert.equal(p.scheduler.status(id), STATUS.COMPLETED);
  assert.ok(pub.events.filter((e) => e.type === 'JobRetried').length === 2);
});

test('scheduler: exhausted retries dead-letter the job', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const p = createSchedulerPlatform({ clock, publisher: pub });
  const id = p.scheduler.schedule({
    name: 'always-fails',
    owner: 'sys',
    retryPolicy: { type: 'fixed', maxAttempts: 1, delayMs: 50 },
    handler: () => {
      throw new Error('nope');
    },
  });
  await p.scheduler.tick(1000); // fail → retry (1)
  clock.set(1050);
  await p.scheduler.tick(1050); // fail → exhausted → DLQ
  assert.equal(p.scheduler.status(id), STATUS.FAILED);
  const dlq = p.scheduler.deadLetter();
  assert.equal(dlq.length, 1);
  assert.equal(dlq[0].jobId, id);
  assert.ok(pub.events.some((e) => e.type === 'JobFailed'));
});

// ── timeout ────────────────────────────────────────────────────────────────────

test('scheduler: a job exceeding its timeout is timed out (and can retry)', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const p = createSchedulerPlatform({ clock, publisher: pub });
  let aborted = false;
  const id = p.scheduler.schedule({
    name: 'slow',
    owner: 'sys',
    timeout: 20,
    retryPolicy: { type: 'none' },
    handler: (ctx) =>
      new Promise((resolve) => {
        ctx.signal && ctx.signal.addEventListener('abort', () => (aborted = true));
        setTimeout(resolve, 1000); // longer than timeout
      }),
  });
  await p.scheduler.tick(1000);
  assert.equal(p.scheduler.status(id), STATUS.FAILED); // no retry → DLQ after timeout
  assert.ok(pub.events.some((e) => e.type === 'JobTimedOut'));
  assert.equal(aborted, true); // abort signal fired on timeout
});

// ── cancellation + pause/resume ────────────────────────────────────────────────

test('scheduler: cancel/pause/resume behave correctly', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ clock });
  const ran = [];
  const id = p.scheduler.scheduleAfter(
    { name: 'x', owner: 'sys', handler: () => ran.push(1) },
    100
  );
  p.scheduler.pause(id);
  clock.set(1200);
  await p.scheduler.tick(1200);
  assert.equal(ran.length, 0); // paused → not run
  p.scheduler.resume(id);
  await p.scheduler.tick(1200);
  assert.equal(ran.length, 1);

  const id2 = p.scheduler.scheduleAfter(
    { name: 'y', owner: 'sys', handler: () => ran.push(2) },
    100
  );
  assert.equal(p.scheduler.cancel(id2), true);
  clock.set(1400);
  await p.scheduler.tick(1400);
  assert.equal(p.scheduler.status(id2), STATUS.CANCELLED);
  assert.equal(ran.length, 1); // cancelled never ran
});

// ── execution isolation + failure injection ───────────────────────────────────

test('scheduler: a throwing job never affects sibling jobs (isolation)', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ concurrency: 3, clock });
  const ok = [];
  p.scheduler.schedule({
    name: 'bad',
    owner: 'sys',
    handler: () => {
      throw new Error('x');
    },
  });
  p.scheduler.schedule({ name: 'good1', owner: 'sys', handler: () => ok.push(1) });
  p.scheduler.schedule({ name: 'good2', owner: 'sys', handler: () => ok.push(2) });
  await p.scheduler.tick(1000);
  assert.equal(ok.length, 2); // siblings ran despite the failure
});

// ── runNow ──────────────────────────────────────────────────────────────────

test('scheduler: runNow executes immediately regardless of nextRun', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ clock });
  let ran = false;
  const id = p.scheduler.scheduleAfter(
    { name: 'later', owner: 'sys', handler: () => (ran = true) },
    100000
  );
  await p.scheduler.runNow(id);
  assert.equal(ran, true);
  assert.equal(p.scheduler.status(id), STATUS.COMPLETED);
});

// ── observability ──────────────────────────────────────────────────────────────

test('scheduler: metrics + prometheus reflect activity', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ concurrency: 2, clock });
  p.scheduler.schedule({ name: 'a', owner: 'sys', handler: () => {} });
  p.scheduler.schedule({
    name: 'b',
    owner: 'sys',
    handler: () => {
      throw new Error('e');
    },
  });
  await p.scheduler.tick(1000);
  const m = p.scheduler.metrics();
  assert.equal(m.scheduled, 2);
  assert.equal(m.completed, 1);
  assert.equal(m.failed, 1);
  assert.equal(m.concurrency, 2);
  const prom = p.metrics.prometheus();
  assert.match(prom, /scheduler_jobs_scheduled_total 2/);
  assert.match(prom, /scheduler_worker_utilization/);
});

// ── SDK adapter: ownership + capability enforcement ────────────────────────────

test('scheduler SDK adapter: owner scoping + capability enforcement', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ clock });
  const portA = toSchedulerPort(p.scheduler, { owner: 'ext-a' });
  const portB = toSchedulerPort(p.scheduler, { owner: 'ext-b' });
  const idA = portA.schedule({ name: 'a-job', handler: () => {} });
  portB.schedule({ name: 'b-job', handler: () => {} });
  assert.equal(portA.list().length, 1); // sees only its own
  assert.equal(portA.list()[0].owner, 'ext-a');
  assert.throws(() => portB.cancel(idA), /does not own/); // cannot touch another's job
  assert.equal(portB.exists(idA), false);

  const denied = toSchedulerPort(p.scheduler, { owner: 'ext-c', canSchedule: false });
  assert.throws(() => denied.schedule({ name: 'nope', handler: () => {} }), /lacks capability/);
});

// ── recovery: shutdown drains in-flight jobs ───────────────────────────────────

test('scheduler: graceful shutdown waits for in-flight work', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ concurrency: 2, clock });
  let finished = 0;
  p.scheduler.schedule({
    name: 'slow',
    owner: 'sys',
    handler: () =>
      new Promise((r) =>
        setTimeout(() => {
          finished++;
          r();
        }, 20)
      ),
  });
  const tickP = p.scheduler.tick(1000);
  await p.scheduler.shutdown(); // must not resolve before the job finishes
  assert.equal(finished, 1);
  await tickP;
});

// ── stress + performance ───────────────────────────────────────────────────────

test('scheduler: stress — 1000 jobs all execute under concurrency', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ concurrency: 16, clock });
  let done = 0;
  for (let i = 0; i < 1000; i++) {
    p.scheduler.schedule({
      name: 'j' + i,
      owner: 'sys',
      handler: () => {
        done++;
      },
    });
  }
  const start = Date.now();
  await p.scheduler.tick(1000);
  const elapsed = Date.now() - start;
  assert.equal(done, 1000);
  assert.equal(p.scheduler.metrics().completed, 1000);
  assert.ok(elapsed < 1000, `too slow: ${elapsed}ms`);
});
