'use strict';

/**
 * jobs-shadow.test.js — Phase 17.5 (first integration under G1.0)
 *
 * Jobs Kernel shadow integration:
 *   • shared shadow framework: deepEqual/flatten + metrics incl. confidenceLevel + coveragePct
 *   • Jobs Adapter encode/decode + inert guard + NON-EXECUTION (never ticks)
 *   • legacy jobs inventory
 *   • shadow verifier: 100% parity across all descriptor + native fields
 *   • disabled shadow → no kernel interaction; failure path → recorded, never throws
 *   • flag gating (SHADOW requires PLATFORM)
 *   • enterprise boot: OFF=inert, PLATFORM-only (no comparisons), both ON (parity + coverage 100%)
 *   • PROOF the kernel never executes a job (running=0, none completed)
 *   • all three shadows (config + observability + jobs) run together at 100%
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createJobsAdapter,
  createLegacyJobsSource,
  createJobsShadow,
  createShadowMetrics,
  sharedShadow,
  AdapterNotWiredError,
} = require('../../src/platform-adapters');
const { toKernelSpec, fromKernelModel, expectedStatus } = require('../../src/platform-adapters/jobs');
const { selectJobsFlags } = require('../../src/enterprise/jobsShadow');
const { bootEnterprise } = require('../../src/enterprise');

const quiet = { info() {}, warn() {}, error() {}, success() {}, fatal() {} };

/**
 * In-memory fake Jobs kernel (register/enqueue/schedule/status/health/tick). Records whether
 * tick() was ever called, so tests can PROVE the shadow never executes a job.
 */
function fakeJobsKernel() {
  const handlers = new Map();
  const jobs = new Map(); // `${ns}:${id}` -> model
  let ticked = false;
  let idSeq = 0;
  const put = (ns, spec, status) => {
    const jobId = `job-${++idSeq}`;
    const model = {
      jobId,
      namespace: ns,
      type: spec.type,
      payload: spec.payload ?? null,
      priority: spec.priority ?? 'normal',
      status,
      maxAttempts: spec.maxAttempts ?? 1,
      scheduledTime: status === 'scheduled' ? 1000 + (spec.delayMs || 0) : null,
    };
    jobs.set(`${ns}:${jobId}`, model);
    return { ...model };
  };
  return {
    _ticked: () => ticked,
    _count: () => jobs.size,
    _statuses: () => [...jobs.values()].map((j) => j.status),
    register: ({ type, handler }) => {
      handlers.set(type, handler);
      return { type, registered: true };
    },
    enqueue: async (spec, opts = {}) => {
      if (!handlers.has(spec.type)) throw new Error('no handler');
      return put(opts.namespace || 'default', spec, 'queued');
    },
    schedule: async (spec, opts = {}) => {
      if (!handlers.has(spec.type)) throw new Error('no handler');
      return put(opts.namespace || 'default', spec, 'scheduled');
    },
    status: async (spec, opts = {}) => {
      const id = typeof spec === 'string' ? spec : spec.jobId;
      return jobs.get(`${(opts && opts.namespace) || 'default'}:${id}`) || null;
    },
    tick: async () => {
      ticked = true;
    }, // the adapter must NEVER call this
    health: async () => ({ ok: true, jobs: jobs.size, running: 0, deadLetter: 0 }),
  };
}

// ── shared framework ───────────────────────────────────────────────────────────
test('shared metrics expose coveragePct + confidenceLevel', () => {
  const m = createShadowMetrics({ declaredSurface: 4 });
  m.recordComparison(true, 1, 'a');
  m.recordComparison(true, 1, 'b');
  const s = m.snapshot();
  assert.equal(s.parityPct, 100);
  assert.equal(s.coveragePct, 50); // 2 of 4 declared keys covered
  m.recordComparison(true, 1, 'c');
  m.recordComparison(true, 1, 'd');
  assert.equal(m.snapshot().coveragePct, 100);
});

test('shared deepEqual/flatten behave canonically', () => {
  assert.equal(sharedShadow.deepEqual({ a: [1, 2] }, { a: [1, 2] }), true);
  assert.deepEqual(sharedShadow.flatten({ a: { b: 1 }, c: [1] }), { 'a.b': 1, c: [1] });
});

// ── adapter ────────────────────────────────────────────────────────────────────
test('jobs adapter is inert without a port', () => {
  const a = createJobsAdapter();
  assert.equal(a.consumed(), false);
  assert.rejects(() => a.record({ id: 'x', kind: 'interval' }), AdapterNotWiredError);
});

test('toKernelSpec/fromKernelModel + expectedStatus are pure and correct', () => {
  const d = { id: 'backup', kind: 'interval', intervalMs: 1000, idempotent: true };
  const spec = toKernelSpec(d);
  assert.equal(spec.type, 'backup');
  assert.equal(spec.delayMs, 1000);
  assert.deepEqual(spec.payload, d);
  assert.equal(expectedStatus('interval'), 'scheduled');
  assert.equal(expectedStatus('startup'), 'queued');
  const back = fromKernelModel({ type: 'backup', status: 'scheduled', payload: d });
  assert.deepEqual(back, { descriptor: d, kernel: { type: 'backup', status: 'scheduled' } });
});

// ── shadow parity + NON-EXECUTION ────────────────────────────────────────────────
test('shadow reaches 100% parity and NEVER executes a job', async () => {
  const kernel = fakeJobsKernel();
  const adapter = createJobsAdapter({ port: kernel });
  const legacy = createLegacyJobsSource();
  const shadow = createJobsShadow({ adapter, legacy, enabled: true });
  const report = await shadow.verify();

  assert.equal(report.enabled, true);
  assert.equal(report.jobs, 5);
  assert.equal(report.mismatched, 0);
  assert.deepEqual(report.mismatchKeys, []);
  assert.equal(report.parityPct, 100);
  assert.equal(report.coveragePct, 100);
  assert.equal(report.confidenceLevel, 1);

  // PROOF of non-execution: tick was never called; all jobs are scheduled/queued (not running).
  assert.equal(kernel._ticked(), false);
  assert.equal(kernel._count(), 5);
  for (const s of kernel._statuses()) assert.ok(s === 'scheduled' || s === 'queued');
});

test('shadow disabled performs no kernel interaction', async () => {
  const kernel = fakeJobsKernel();
  const adapter = createJobsAdapter({ port: kernel });
  const legacy = createLegacyJobsSource();
  const shadow = createJobsShadow({ adapter, legacy, enabled: false });
  const report = await shadow.verify();
  assert.equal(report.enabled, false);
  assert.equal(kernel._count(), 0); // nothing placed
  assert.equal(shadow.stats().comparisons, 0);
});

test('kernel failure is recorded and verify never throws', async () => {
  const adapter = createJobsAdapter({
    port: {
      register: () => ({ registered: true }),
      schedule: async () => {
        throw new Error('kernel down');
      },
      enqueue: async () => {
        throw new Error('kernel down');
      },
      status: async () => null,
    },
  });
  const legacy = createLegacyJobsSource();
  const shadow = createJobsShadow({ adapter, legacy, enabled: true });
  let report;
  await assert.doesNotReject(async () => {
    report = await shadow.verify();
  });
  assert.equal(report.parityPct, 0);
  assert.equal(shadow.stats().verificationFailures, 1);
});

test('mismatch is detected when the kernel misrepresents a job', async () => {
  const kernel = fakeJobsKernel();
  // Corrupt schedule to drop a payload field → descriptor mismatch.
  const orig = kernel.schedule;
  kernel.schedule = async (spec, opts) => {
    const m = await orig({ ...spec, payload: { ...spec.payload, owner: 'WRONG' } }, opts);
    return m;
  };
  const adapter = createJobsAdapter({ port: kernel });
  const legacy = createLegacyJobsSource({ jobs: [{ id: 'x', kind: 'interval', intervalMs: 10, idempotent: true, owner: 'right', enabled: true }] });
  const shadow = createJobsShadow({ adapter, legacy, enabled: true });
  const report = await shadow.verify();
  assert.ok(report.mismatched >= 1);
  assert.ok(report.mismatchKeys.some((k) => k.includes('owner')));
});

// ── legacy inventory ─────────────────────────────────────────────────────────────
test('legacy jobs inventory matches the real timers', () => {
  const legacy = createLegacyJobsSource();
  assert.deepEqual(legacy.ids().sort(), ['backup', 'cache-sweep', 'ghost-trip-cleanup', 'taxi-autofix', 'wal-checkpoint']);
  assert.equal(legacy.get('backup').intervalMs, 6 * 60 * 60 * 1000);
  assert.equal(legacy.get('cache-sweep').intervalMs, 30 * 1000);
  assert.equal(legacy.get('wal-checkpoint').intervalMs, 5 * 60 * 1000);
  assert.equal(legacy.get('taxi-autofix').intervalMs, 60 * 60 * 1000);
  assert.equal(legacy.get('ghost-trip-cleanup').kind, 'startup');
});

// ── flag gating ──────────────────────────────────────────────────────────────────
test('selectJobsFlags: SHADOW requires PLATFORM', () => {
  assert.deepEqual(selectJobsFlags({ PLATFORM_JOBS: '1', SHADOW_JOBS: '1' }), { platformJobs: true, shadowJobs: true });
  assert.deepEqual(selectJobsFlags({ SHADOW_JOBS: '1' }), { platformJobs: false, shadowJobs: false });
  assert.deepEqual(selectJobsFlags({ PLATFORM_JOBS: '1' }), { platformJobs: true, shadowJobs: false });
  assert.deepEqual(selectJobsFlags({}), { platformJobs: false, shadowJobs: false });
});

// ── enterprise boot ────────────────────────────────────────────────────────────
function fakeApp() {
  let listening = false;
  return { port: 3999, listening: () => listening, start: async () => { listening = true; }, stop: async () => { listening = false; } };
}

test('boot with jobs flags OFF is identical to 17.4 (no consumption)', async () => {
  const { adapters, jobsShadow, jobsParity, host } = await bootEnterprise({
    logger: quiet, createApplication: fakeApp, installSignalHandlers: false,
    platformJobs: false, shadowJobs: false,
  });
  assert.deepEqual(adapters.consumed(), []);
  assert.equal(jobsShadow, null);
  assert.equal(jobsParity, null);
  assert.equal((await host.verify()).ok, true);
  await host.stop();
});

test('boot PLATFORM_JOBS=1, SHADOW_JOBS=0: wired, no comparisons', async () => {
  const { adapters, jobsShadow, jobsParity, host } = await bootEnterprise({
    logger: quiet, createApplication: fakeApp, installSignalHandlers: false,
    platformJobs: true, shadowJobs: false,
  });
  assert.deepEqual(adapters.consumed(), ['jobs']);
  assert.equal(jobsShadow.enabled(), false);
  assert.equal(jobsParity, null);
  assert.equal((await host.verify()).ok, true);
  await host.stop();
});

test('boot both jobs flags ON: parity + coverage 100%, phase 17.5, kernel never ran', async () => {
  const { jobsParity, host, service, runtime } = await bootEnterprise({
    logger: quiet, createApplication: fakeApp, installSignalHandlers: false,
    platformJobs: true, shadowJobs: true,
  });
  assert.equal(jobsParity.parityPct, 100);
  assert.equal(jobsParity.coveragePct, 100);
  assert.equal(jobsParity.mismatched, 0);
  assert.equal(service.metadata().phase, '17.5');
  assert.deepEqual(service.metadata().kernelsConsumed, ['jobs']);
  // real kernel proof: nothing running / completed
  const jk = runtime.platform().getKernel('jobs');
  const h = await jk.health();
  assert.equal(h.running, 0);
  await host.stop();
});

test('config + observability + jobs shadows run together, all 100%', async () => {
  const { parity, observabilityParity, jobsParity, adapters, host } = await bootEnterprise({
    logger: quiet, createApplication: fakeApp, installSignalHandlers: false,
    platformConfig: true, shadowConfig: true,
    platformObservability: true, shadowObservability: true,
    platformJobs: true, shadowJobs: true,
    envExports: { PORT: 3000, NODE_ENV: 'test' },
  });
  assert.equal(parity.parityPct, 100);
  assert.equal(observabilityParity.parityPct, 100);
  assert.equal(jobsParity.parityPct, 100);
  assert.deepEqual(adapters.consumed().sort(), ['configuration', 'jobs', 'observability']);
  await host.stop();
});
