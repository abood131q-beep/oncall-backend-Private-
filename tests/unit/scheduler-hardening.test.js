'use strict';

/**
 * Enterprise Scheduler — production hardening tests (Phase 14.3.3 A-001).
 * Additive: concurrent-tick protection, worker-crash recovery, queue consistency,
 * monotonic-clock verification, bounded graceful shutdown, restart, long-running
 * jobs, dead-letter + queue-latency metrics, diagnostics/health, startup + job
 * snapshot immutability + lifecycle history. Does not duplicate scheduler.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSchedulerPlatform } = require('../../src/application/scheduler');

function makeClock(start = 1000) {
  const box = { now: start };
  const clock = () => box.now;
  clock.set = (n) => (box.now = n);
  return clock;
}

// ── concurrent-tick protection ─────────────────────────────────────────────────

test('hardening: overlapping ticks never double-run a job', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ concurrency: 1, clock });
  let runs = 0;
  p.scheduler.schedule({
    name: 'once',
    owner: 'sys',
    handler: () =>
      new Promise((r) =>
        setTimeout(() => {
          runs++;
          r();
        }, 15)
      ),
  });
  // Fire three ticks concurrently against the same due job.
  await Promise.all([p.scheduler.tick(1000), p.scheduler.tick(1000), p.scheduler.tick(1000)]);
  assert.equal(runs, 1); // executed exactly once despite 3 ticks
  assert.equal(p.scheduler.verifyQueue().ok, true);
});

// ── worker-crash recovery ────────────────────────────────────────────────────

test('hardening: recover() re-queues jobs stuck RUNNING (simulated crash)', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ concurrency: 2, clock });
  const s = p.scheduler;
  let started = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  // A job whose worker "crashes": it starts and hangs on a gate the test controls.
  const id = s.schedule({
    name: 'hangs',
    owner: 'sys',
    handler: () => {
      started++;
      return gate;
    },
  });
  const tickP = s.tick(1000); // starts it; stays in-flight until the gate opens
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(started, 1);
  assert.equal(s.status(id), 'running');
  // Time passes; the worker is considered crashed → recover re-queues it.
  clock.set(1000 + 120000);
  const recovered = s.recover({ maxRunningMs: 60000, now: 1000 + 120000 });
  assert.deepEqual(recovered, [id]);
  assert.equal(s.status(id), 'scheduled');
  assert.equal(s.verifyQueue().ok, true); // running counter reconciled to 0
  // Let the abandoned execution settle so no promise dangles.
  release();
  await tickP;
});

// ── queue consistency ──────────────────────────────────────────────────────────

test('hardening: verifyQueue stays consistent across a mixed workload', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ concurrency: 4, clock });
  for (let i = 0; i < 20; i++) {
    p.scheduler.schedule({
      name: 'j' + i,
      owner: 'sys',
      handler: () => (i % 3 === 0 ? Promise.reject(new Error('x')) : Promise.resolve()),
      retryPolicy: { type: 'none' },
    });
  }
  await p.scheduler.tick(1000);
  const q = p.scheduler.verifyQueue();
  assert.equal(q.ok, true);
  assert.equal(q.runningCounter, 0); // all settled
});

// ── monotonic-clock verification ─────────────────────────────────────────────

test('hardening: a backwards clock is detected and reported, not fatal', async () => {
  const clock = makeClock(5000);
  const p = createSchedulerPlatform({ clock });
  let ran = 0;
  p.scheduler.schedule({ name: 'a', owner: 'sys', handler: () => ran++ });
  await p.scheduler.tick(5000);
  await p.scheduler.tick(4000); // clock went backwards
  assert.equal(p.scheduler.diagnostics().clockRegressions, 1);
  assert.equal(p.scheduler.health().clockMonotonic, false);
  assert.equal(ran, 1); // still functioned
});

// ── bounded graceful shutdown + restart ────────────────────────────────────────

test('hardening: shutdown drains in-flight then reports drained', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ concurrency: 2, clock });
  let done = 0;
  p.scheduler.schedule({
    name: 'slow',
    owner: 'sys',
    handler: () =>
      new Promise((r) =>
        setTimeout(() => {
          done++;
          r();
        }, 20)
      ),
  });
  const tickP = p.scheduler.tick(1000);
  const res = await p.scheduler.shutdown({ maxWaitMs: 5000 });
  assert.equal(res.drained, true);
  assert.equal(done, 1);
  await tickP;
});

test('hardening: shutdown is bounded and cannot hang forever', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ concurrency: 1, clock });
  const id = p.scheduler.schedule({
    name: 'hang',
    owner: 'sys',
    handler: (ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal && ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  const tickP = p.scheduler.tick(1000);
  await new Promise((r) => setTimeout(r, 5));
  const res = await p.scheduler.shutdown({ maxWaitMs: 30 });
  assert.equal(res.drained, false); // gave up after the bound
  assert.ok(res.stillRunning >= 1);
  // Settle the abandoned execution so no promise dangles.
  p.scheduler.cancel(id);
  await tickP;
});

// ── long-running jobs + queue latency metric ───────────────────────────────────

test('hardening: queue latency is measured from due to start', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ clock });
  p.scheduler.scheduleAfter({ name: 'x', owner: 'sys', handler: () => {} }, 100); // due at 1100
  clock.set(1300); // 200ms late
  await p.scheduler.tick(1300);
  const m = p.scheduler.metrics();
  assert.equal(m.queueLatencyLastMs, 200);
  assert.ok(m.uptimeMs >= 0);
});

// ── dead-letter metrics ──────────────────────────────────────────────────────

test('hardening: dead-letter size is exposed in metrics + prometheus', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ clock });
  p.scheduler.schedule({
    name: 'fail',
    owner: 'sys',
    retryPolicy: { type: 'none' },
    handler: () => {
      throw new Error('boom');
    },
  });
  await p.scheduler.tick(1000);
  assert.equal(p.scheduler.metrics().deadLetterSize, 1);
  assert.match(p.metrics.prometheus(), /scheduler_dead_letter_size 1/);
  assert.match(p.metrics.prometheus(), /scheduler_uptime_ms/);
});

// ── diagnostics + health + startup verification ────────────────────────────────

test('hardening: diagnostics, health, and startup verification', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ concurrency: 3, clock });
  assert.equal(p.scheduler.verifyStartup().ok, true);
  p.scheduler.schedule({ name: 'a', owner: 'sys', handler: () => {} });
  await p.scheduler.tick(1000);
  const d = p.scheduler.diagnostics();
  assert.equal(typeof d.uptimeMs, 'number');
  assert.equal(d.clockMonotonic, true);
  assert.equal(d.queue.ok, true);
  assert.ok(d.metrics);
  assert.equal(p.scheduler.health().status, 'healthy');
});

// ── lifecycle history + immutable job snapshot ─────────────────────────────────

test('hardening: lifecycle history records transitions; jobSnapshot is frozen', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ clock, historyLimit: 50 });
  const id = p.scheduler.schedule({ name: 'a', owner: 'sys', handler: () => {} });
  await p.scheduler.tick(1000);
  const hist = p.scheduler
    .history()
    .filter((h) => h.jobId === id)
    .map((h) => h.type);
  assert.ok(hist.includes('JobScheduled'));
  assert.ok(hist.includes('JobStarted'));
  assert.ok(hist.includes('JobCompleted'));
  const snap = p.scheduler.jobSnapshot(id);
  assert.ok(Object.isFrozen(snap));
  assert.throws(() => {
    snap.status = 'hacked';
  }, TypeError);
  assert.equal(p.scheduler.jobSnapshot('nope'), null);
});

// ── stress under concurrency remains consistent ────────────────────────────────

test('hardening: stress — 2000 jobs, queue + counters stay consistent', async () => {
  const clock = makeClock(1000);
  const p = createSchedulerPlatform({ concurrency: 32, clock });
  let done = 0;
  for (let i = 0; i < 2000; i++) {
    p.scheduler.schedule({
      name: 'j' + i,
      owner: 'sys',
      handler: () => {
        done++;
      },
    });
  }
  await p.scheduler.tick(1000);
  assert.equal(done, 2000);
  assert.equal(p.scheduler.verifyQueue().ok, true);
  assert.equal(p.scheduler.metrics().completed, 2000);
});
