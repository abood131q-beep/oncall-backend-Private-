'use strict';

/**
 * scheduler-shadow.test.js — Phase 17.6
 *
 * Scheduler Kernel shadow integration (built on the shared generic round-trip verifier):
 *   • Scheduler Adapter encode/decode + inert guard + NON-OWNERSHIP (never start()/tick())
 *   • legacy schedule inventory (derived from the canonical timer inventory)
 *   • shadow verifier: 100% parity across descriptor + native scheduling fields
 *   • disabled shadow → no kernel interaction; failure path → recorded, never throws
 *   • mismatch detection; flag gating (SHADOW requires PLATFORM)
 *   • enterprise boot: OFF=inert, PLATFORM-only (no comparisons), both ON (parity + coverage 100%)
 *   • PROOF the kernel never arms a timer / never executes (start & tick never called; running=0)
 *   • all four shadows (config + observability + jobs + scheduler) run together at 100%
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSchedulerAdapter,
  createLegacySchedulerSource,
  createSchedulerShadow,
  AdapterNotWiredError,
} = require('../../src/platform-adapters');
const {
  toKernelSpec,
  fromKernelModel,
  expectedScheduleType,
} = require('../../src/platform-adapters/scheduler');
const { selectSchedulerFlags } = require('../../src/enterprise/schedulerShadow');
const { bootEnterprise } = require('../../src/enterprise');

const quiet = { info() {}, warn() {}, error() {}, success() {}, fatal() {} };

/**
 * In-memory fake Scheduler kernel. Records whether start()/tick() were ever called so tests
 * can PROVE the shadow never owns a timer and never executes.
 */
function fakeSchedulerKernel() {
  const jobs = new Map();
  let started = false;
  let ticked = false;
  let idSeq = 0;
  const register = (jobSpec, scheduleType) => {
    const jobId = `sch-${++idSeq}`;
    jobs.set(jobId, {
      jobId,
      name: jobSpec.name,
      owner: jobSpec.owner,
      scheduleType,
      status: 'scheduled',
      metadata: jobSpec.metadata || {},
      nextRun: 1000,
    });
    return jobId;
  };
  return {
    _started: () => started,
    _ticked: () => ticked,
    _statuses: () => [...jobs.values()].map((j) => j.status),
    scheduleRecurring: (jobSpec) => register(jobSpec, 'interval'),
    scheduleAt: (jobSpec) => register(jobSpec, 'once'),
    jobSnapshot: (jobId) => (jobs.has(jobId) ? { ...jobs.get(jobId) } : null),
    start: () => {
      started = true;
    }, // the adapter must NEVER call this
    tick: () => {
      ticked = true;
    }, // the adapter must NEVER call this
    health: async () => ({ status: 'healthy', running: 0 }),
  };
}

// ── adapter ────────────────────────────────────────────────────────────────────
test('scheduler adapter is inert without a port', () => {
  const a = createSchedulerAdapter();
  assert.equal(a.consumed(), false);
  assert.rejects(() => a.record({ id: 'x', kind: 'interval' }), AdapterNotWiredError);
});

test('toKernelSpec/fromKernelModel/expectedScheduleType are pure and correct', () => {
  const d = { id: 'backup', owner: 'svc', kind: 'interval', intervalMs: 1000, cron: null, enabled: true };
  const spec = toKernelSpec(d);
  assert.equal(spec.name, 'backup');
  assert.equal(spec.owner, 'svc');
  assert.equal(spec.intervalMs, 1000);
  assert.deepEqual(spec.metadata.payload, d);
  assert.equal(expectedScheduleType('interval'), 'interval');
  assert.equal(expectedScheduleType('startup'), 'once');
  const back = fromKernelModel({ name: 'backup', owner: 'svc', scheduleType: 'interval', status: 'scheduled', metadata: { payload: d } });
  assert.deepEqual(back, {
    descriptor: d,
    kernel: { name: 'backup', owner: 'svc', scheduleType: 'interval', status: 'scheduled' },
  });
});

// ── shadow parity + NON-OWNERSHIP ─────────────────────────────────────────────────
test('shadow reaches 100% parity and NEVER arms a timer / executes', async () => {
  const kernel = fakeSchedulerKernel();
  const adapter = createSchedulerAdapter({ port: kernel });
  const legacy = createLegacySchedulerSource();
  const shadow = createSchedulerShadow({ adapter, legacy, enabled: true });
  const report = await shadow.verify();

  assert.equal(report.enabled, true);
  assert.equal(report.schedules, 5);
  assert.equal(report.mismatched, 0);
  assert.deepEqual(report.mismatchKeys, []);
  assert.equal(report.parityPct, 100);
  assert.equal(report.coveragePct, 100);
  assert.equal(report.confidenceLevel, 1);

  // PROOF of non-ownership/non-execution: start() and tick() never called; all 'scheduled'.
  assert.equal(kernel._started(), false);
  assert.equal(kernel._ticked(), false);
  for (const s of kernel._statuses()) assert.equal(s, 'scheduled');
});

test('shadow disabled performs no kernel interaction', async () => {
  const kernel = fakeSchedulerKernel();
  const adapter = createSchedulerAdapter({ port: kernel });
  const shadow = createSchedulerShadow({ adapter, legacy: createLegacySchedulerSource(), enabled: false });
  const report = await shadow.verify();
  assert.equal(report.enabled, false);
  assert.equal(kernel._statuses().length, 0); // nothing scheduled
  assert.equal(shadow.stats().comparisons, 0);
});

test('kernel failure is recorded and verify never throws', async () => {
  const adapter = createSchedulerAdapter({
    port: {
      scheduleRecurring: () => {
        throw new Error('kernel down');
      },
      scheduleAt: () => {
        throw new Error('kernel down');
      },
      jobSnapshot: () => null,
    },
  });
  const shadow = createSchedulerShadow({ adapter, legacy: createLegacySchedulerSource(), enabled: true });
  let report;
  await assert.doesNotReject(async () => {
    report = await shadow.verify();
  });
  assert.equal(report.parityPct, 0);
  assert.equal(shadow.stats().verificationFailures, 1);
});

test('mismatch is detected when the kernel misrepresents a schedule', async () => {
  const kernel = fakeSchedulerKernel();
  const orig = kernel.scheduleRecurring;
  kernel.scheduleRecurring = (jobSpec) =>
    orig({ ...jobSpec, metadata: { payload: { ...jobSpec.metadata.payload, owner: 'WRONG' } } });
  const adapter = createSchedulerAdapter({ port: kernel });
  const legacy = createLegacySchedulerSource({ schedules: [{ id: 'x', owner: 'right', kind: 'interval', intervalMs: 10, cron: null, enabled: true }] });
  const shadow = createSchedulerShadow({ adapter, legacy, enabled: true });
  const report = await shadow.verify();
  assert.ok(report.mismatched >= 1);
  assert.ok(report.mismatchKeys.some((k) => k.includes('owner')));
});

// ── legacy inventory ─────────────────────────────────────────────────────────────
test('legacy schedule inventory is derived from the canonical timers', () => {
  const legacy = createLegacySchedulerSource();
  assert.deepEqual(legacy.ids().sort(), ['backup', 'cache-sweep', 'ghost-trip-cleanup', 'taxi-autofix', 'wal-checkpoint']);
  assert.equal(legacy.get('backup').intervalMs, 6 * 60 * 60 * 1000);
  assert.equal(legacy.get('backup').cron, null);
  assert.equal(legacy.get('ghost-trip-cleanup').kind, 'startup');
});

// ── flag gating ──────────────────────────────────────────────────────────────────
test('selectSchedulerFlags: SHADOW requires PLATFORM', () => {
  assert.deepEqual(selectSchedulerFlags({ PLATFORM_SCHEDULER: '1', SHADOW_SCHEDULER: '1' }), { platformScheduler: true, shadowScheduler: true });
  assert.deepEqual(selectSchedulerFlags({ SHADOW_SCHEDULER: '1' }), { platformScheduler: false, shadowScheduler: false });
  assert.deepEqual(selectSchedulerFlags({ PLATFORM_SCHEDULER: '1' }), { platformScheduler: true, shadowScheduler: false });
  assert.deepEqual(selectSchedulerFlags({}), { platformScheduler: false, shadowScheduler: false });
});

// ── enterprise boot ────────────────────────────────────────────────────────────
function fakeApp() {
  let listening = false;
  return { port: 3999, listening: () => listening, start: async () => { listening = true; }, stop: async () => { listening = false; } };
}

test('boot with scheduler flags OFF is identical to 17.5 (no consumption)', async () => {
  const { adapters, schedulerShadow, schedulerParity, host } = await bootEnterprise({
    logger: quiet, createApplication: fakeApp, installSignalHandlers: false,
    platformScheduler: false, shadowScheduler: false,
  });
  assert.deepEqual(adapters.consumed(), []);
  assert.equal(schedulerShadow, null);
  assert.equal(schedulerParity, null);
  assert.equal((await host.verify()).ok, true);
  await host.stop();
});

test('boot PLATFORM_SCHEDULER=1, SHADOW_SCHEDULER=0: wired, no comparisons', async () => {
  const { adapters, schedulerShadow, schedulerParity, host } = await bootEnterprise({
    logger: quiet, createApplication: fakeApp, installSignalHandlers: false,
    platformScheduler: true, shadowScheduler: false,
  });
  assert.deepEqual(adapters.consumed(), ['scheduler']);
  assert.equal(schedulerShadow.enabled(), false);
  assert.equal(schedulerParity, null);
  assert.equal((await host.verify()).ok, true);
  await host.stop();
});

test('boot both scheduler flags ON: parity + coverage 100%, phase 17.6, kernel never ran', async () => {
  const { schedulerParity, host, service, runtime } = await bootEnterprise({
    logger: quiet, createApplication: fakeApp, installSignalHandlers: false,
    platformScheduler: true, shadowScheduler: true,
  });
  assert.equal(schedulerParity.parityPct, 100);
  assert.equal(schedulerParity.coveragePct, 100);
  assert.equal(schedulerParity.mismatched, 0);
  assert.equal(service.metadata().phase, '17.6');
  assert.deepEqual(service.metadata().kernelsConsumed, ['scheduler']);
  const sk = runtime.platform().getKernel('scheduler');
  assert.equal((await sk.health()).running, 0);
  await host.stop();
});

test('all four shadows (config + observability + jobs + scheduler) run together, all 100%', async () => {
  const { parity, observabilityParity, jobsParity, schedulerParity, adapters, host } = await bootEnterprise({
    logger: quiet, createApplication: fakeApp, installSignalHandlers: false,
    platformConfig: true, shadowConfig: true,
    platformObservability: true, shadowObservability: true,
    platformJobs: true, shadowJobs: true,
    platformScheduler: true, shadowScheduler: true,
    envExports: { PORT: 3000, NODE_ENV: 'test' },
  });
  assert.equal(parity.parityPct, 100);
  assert.equal(observabilityParity.parityPct, 100);
  assert.equal(jobsParity.parityPct, 100);
  assert.equal(schedulerParity.parityPct, 100);
  assert.deepEqual(adapters.consumed().sort(), ['configuration', 'jobs', 'observability', 'scheduler']);
  await host.stop();
});
