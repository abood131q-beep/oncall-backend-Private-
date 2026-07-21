'use strict';

/**
 * observability-shadow.test.js — Phase 17.4
 *
 * Observability Kernel shadow integration:
 *   • Observability Adapter encode/decode round-trip + inert guard
 *   • legacy source, deep-equal, flatten, shadow verifier
 *   • parity across health/readiness/liveness/counters/gauges/timers/tags/event/log
 *   • disabled shadow returns legacy, no kernel interaction
 *   • failure path (kernel throws) → recorded, legacy returned, never throws
 *   • flag gating (SHADOW requires PLATFORM)
 *   • full enterprise boot: OFF=inert, PLATFORM only (no comparisons), both ON (parity 100%)
 *   • the kernel is NEVER authoritative — shadowObserve returns the legacy observation
 *   • the app's /metrics collector is never touched (isolated shadow metrics)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createObservabilityAdapter,
  createLegacyObservabilitySource,
  createObservabilityShadow,
  createObservabilityShadowMetrics,
  AdapterNotWiredError,
} = require('../../src/platform-adapters');
const { toKernelSpec, fromKernelModel } = require('../../src/platform-adapters/observability');
const { selectObservabilityFlags } = require('../../src/enterprise/observabilityShadow');
const { bootEnterprise } = require('../../src/enterprise');

const quiet = { info() {}, warn() {}, error() {}, success() {}, fatal() {} };

// A fake metrics source shaped like src/middleware/metrics.js getMetrics().
function fakeGetMetrics() {
  return {
    responseTimes: [5, 10, 20, 40, 80],
    cpuPercent: 12.5,
    requestCount: 100,
    error4xxCount: 3,
    error5xxCount: 1,
    routes: [],
  };
}

const legacyOptions = {
  getMetrics: fakeGetMetrics,
  processRef: {
    memoryUsage: () => ({ heapUsed: 50, heapTotal: 100, rss: 200 }),
    uptime: () => 42,
    env: { LOG_LEVEL: 'INFO' },
  },
};

/** An in-memory fake Observability kernel port (register/collect/snapshot/health). */
function fakeKernel() {
  const comps = new Map();
  return {
    register: async ({ componentId, service, metadata }) => {
      comps.set(componentId, {
        componentId,
        service,
        healthStatus: 'unknown',
        counters: {},
        gauges: {},
        timers: {},
        metadata: metadata || {},
      });
    },
    collect: async ({ componentId, health, counters, gauges, timers }) => {
      const c = comps.get(componentId);
      if (health != null) c.healthStatus = health;
      for (const [k, v] of Object.entries(counters || {})) c.counters[k] = (c.counters[k] || 0) + Number(v);
      for (const [k, v] of Object.entries(gauges || {})) c.gauges[k] = Number(v);
      for (const [k, v] of Object.entries(timers || {})) {
        const t = c.timers[k] || { count: 0, totalMs: 0, lastMs: 0 };
        t.count++;
        t.totalMs += Number(v);
        t.lastMs = Number(v);
        c.timers[k] = t;
      }
    },
    snapshot: async () => ({ components: [...comps.values()].map((c) => ({ ...c })) }),
    health: async () => ({ ok: true, status: 'healthy' }),
  };
}

// ── adapter round-trip ───────────────────────────────────────────────────────────
test('adapter is inert without a port', () => {
  const a = createObservabilityAdapter();
  assert.equal(a.consumed(), false);
  assert.rejects(() => a.record({}), AdapterNotWiredError);
});

test('toKernelSpec/fromKernelModel losslessly round-trips an observation', () => {
  const legacy = createLegacyObservabilitySource(legacyOptions);
  const obs = legacy.observe();
  const report = toKernelSpec(obs, obs.event.service);
  // simulate the kernel model that collect+register would produce
  const model = {
    componentId: 'x',
    service: report.service,
    healthStatus: report.health,
    counters: { ...report.counters },
    gauges: { ...report.gauges },
    timers: Object.fromEntries(
      Object.entries(report.timers).map(([k, v]) => [k, { count: 1, totalMs: v, lastMs: v }])
    ),
    metadata: report.metadata,
  };
  const back = fromKernelModel(model);
  assert.equal(back.health.status, obs.health.status);
  assert.deepEqual(back.health.checks, obs.health.checks);
  assert.deepEqual(back.health.tags, obs.health.tags);
  assert.deepEqual(back.readiness, obs.readiness);
  assert.deepEqual(back.liveness, obs.liveness);
  assert.deepEqual(back.counters, obs.counters);
  assert.deepEqual(back.gauges, obs.gauges);
  assert.deepEqual(back.timers, obs.timers);
  assert.deepEqual(back.log, obs.log);
});

// ── shadow: enabled, 100% parity ──────────────────────────────────────────────────
test('shadow reaches 100% parity across all observation categories', async () => {
  const legacy = createLegacyObservabilitySource(legacyOptions);
  const adapter = createObservabilityAdapter({ port: fakeKernel() });
  const shadow = createObservabilityShadow({ adapter, legacy, enabled: true });
  const report = await shadow.verify();
  assert.equal(report.enabled, true);
  assert.ok(report.fields >= 15, `expected many fields, got ${report.fields}`);
  assert.equal(report.mismatched, 0);
  assert.deepEqual(report.mismatchKeys, []);
  assert.equal(report.parityPct, 100);
  assert.equal(report.confidenceLevel, 1);
});

// ── shadow: disabled ───────────────────────────────────────────────────────────────
test('shadow disabled returns legacy and never touches the kernel', () => {
  const legacy = createLegacyObservabilitySource(legacyOptions);
  let kernelTouched = false;
  const adapter = createObservabilityAdapter({
    port: { register: async () => (kernelTouched = true), collect: async () => {}, snapshot: async () => ({ components: [] }), health: async () => ({}) },
  });
  const shadow = createObservabilityShadow({ adapter, legacy, enabled: false });
  const obs = shadow.shadowObserve();
  assert.ok(obs.counters); // legacy observation returned
  assert.equal(kernelTouched, false); // disabled ⇒ no kernel interaction
  assert.equal(shadow.stats().comparisons, 0);
});

// ── shadow: failure path ───────────────────────────────────────────────────────────
test('kernel failure is recorded and legacy returned (verify never throws)', async () => {
  const legacy = createLegacyObservabilitySource(legacyOptions);
  const adapter = createObservabilityAdapter({
    port: {
      register: async () => {
        throw new Error('kernel down');
      },
      collect: async () => {},
      snapshot: async () => ({ components: [] }),
      health: async () => ({}),
    },
  });
  const shadow = createObservabilityShadow({ adapter, legacy, enabled: true });
  let report;
  await assert.doesNotReject(async () => {
    report = await shadow.verify();
  });
  assert.equal(report.parityPct, 0);
  assert.equal(shadow.stats().verificationFailures, 1);
  // shadowObserve still returns legacy, fire-and-forget compare doesn't throw
  assert.ok(shadow.shadowObserve().counters);
});

// ── metrics ────────────────────────────────────────────────────────────────────────
test('shadow metrics track parity + confidence, isolated from app metrics', () => {
  const m = createObservabilityShadowMetrics();
  for (let i = 0; i < 20; i++) m.recordComparison(true, 1);
  const s = m.snapshot();
  assert.equal(s.comparisons, 20);
  assert.equal(s.matches, 20);
  assert.equal(s.parityPct, 100);
  assert.equal(s.confidenceLevel, 1);
  m.recordComparison(false, 2);
  assert.ok(m.snapshot().parityPct < 100);
});

// ── flag gating ──────────────────────────────────────────────────────────────────
test('selectObservabilityFlags: SHADOW requires PLATFORM', () => {
  assert.deepEqual(
    selectObservabilityFlags({ PLATFORM_OBSERVABILITY: '1', SHADOW_OBSERVABILITY: '1' }),
    { platformObservability: true, shadowObservability: true }
  );
  assert.deepEqual(selectObservabilityFlags({ SHADOW_OBSERVABILITY: '1' }), {
    platformObservability: false,
    shadowObservability: false,
  });
  assert.deepEqual(selectObservabilityFlags({ PLATFORM_OBSERVABILITY: '1' }), {
    platformObservability: true,
    shadowObservability: false,
  });
  assert.deepEqual(selectObservabilityFlags({}), {
    platformObservability: false,
    shadowObservability: false,
  });
});

// ── enterprise boot integration ────────────────────────────────────────────────────
function fakeApp() {
  let listening = false;
  return {
    port: 3999,
    listening: () => listening,
    start: async () => {
      listening = true;
    },
    stop: async () => {
      listening = false;
    },
  };
}

test('boot with observability flags OFF is identical to 17.3 (no consumption)', async () => {
  const { adapters, observabilityShadow, observabilityParity, host } = await bootEnterprise({
    logger: quiet,
    createApplication: fakeApp,
    installSignalHandlers: false,
    platformObservability: false,
    shadowObservability: false,
  });
  assert.deepEqual(adapters.consumed(), []);
  assert.equal(observabilityShadow, null);
  assert.equal(observabilityParity, null);
  assert.equal((await host.verify()).ok, true);
  await host.stop();
});

test('boot PLATFORM_OBSERVABILITY=1, SHADOW_OBSERVABILITY=0: wired, no comparisons', async () => {
  const { adapters, observabilityShadow, observabilityParity, host } = await bootEnterprise({
    logger: quiet,
    createApplication: fakeApp,
    installSignalHandlers: false,
    platformObservability: true,
    shadowObservability: false,
  });
  assert.deepEqual(adapters.consumed(), ['observability']);
  assert.equal(observabilityShadow.enabled(), false);
  assert.equal(observabilityParity, null);
  assert.equal((await host.verify()).ok, true);
  await host.stop();
});

test('boot with both observability flags ON: parity 100%, host healthy, phase 17.4', async () => {
  const { observabilityShadow, observabilityParity, host, service } = await bootEnterprise({
    logger: quiet,
    createApplication: fakeApp,
    installSignalHandlers: false,
    platformObservability: true,
    shadowObservability: true,
  });
  assert.equal(observabilityParity.parityPct, 100);
  assert.equal(observabilityParity.mismatched, 0);
  assert.equal((await host.health()).status, 'healthy');
  assert.equal(service.metadata().phase, '17.4');
  assert.deepEqual(service.metadata().kernelsConsumed, ['observability']);
  assert.ok(observabilityShadow.shadowObserve().counters); // legacy returned
  await host.stop();
});

test('config + observability shadows can run together, both 100%', async () => {
  const { parity, observabilityParity, adapters, host } = await bootEnterprise({
    logger: quiet,
    createApplication: fakeApp,
    installSignalHandlers: false,
    platformConfig: true,
    shadowConfig: true,
    platformObservability: true,
    shadowObservability: true,
    envExports: { PORT: 3000, NODE_ENV: 'test' },
  });
  assert.equal(parity.parityPct, 100);
  assert.equal(observabilityParity.parityPct, 100);
  assert.deepEqual(adapters.consumed().sort(), ['configuration', 'observability']);
  await host.stop();
});
