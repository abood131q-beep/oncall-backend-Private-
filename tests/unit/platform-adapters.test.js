'use strict';

/**
 * platform-adapters.test.js — Phase 17.2
 *
 * Verifies the Enterprise Platform Adapter Layer:
 *   • all 12 adapters exist and are INERT (consume no kernel) by default,
 *   • active (kernel-consuming) methods refuse to run without an injected port,
 *   • pure translators produce the expected shapes with no side effects,
 *   • injecting a port flips consumed() and delegates to that port.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPlatformAdapters,
  createConfigurationAdapter,
  createIdentityAdapter,
  createHealthAdapter,
  createJobsAdapter,
  AdapterNotWiredError,
} = require('../../src/platform-adapters');

const ADAPTER_NAMES = [
  'configuration',
  'lifecycle',
  'observability',
  'health',
  'jobs',
  'scheduler',
  'identity',
  'policy',
  'audit',
  'notification',
  'ratelimit',
  'messaging',
];

test('layer exposes exactly the 12 named adapters', () => {
  const layer = createPlatformAdapters();
  for (const n of ADAPTER_NAMES) assert.ok(layer[n], `missing adapter: ${n}`);
  assert.equal(layer.list().length, 12);
});

test('Phase 17.2: every adapter is INERT (no kernel consumed)', () => {
  const layer = createPlatformAdapters({ ports: {} });
  assert.deepEqual(layer.consumed(), []);
  assert.equal(layer.layerHealth().consumed, 0);
  assert.equal(layer.layerHealth().total, 12);
  for (const d of layer.describe()) assert.equal(d.consumed, false);
});

test('active kernel-consuming methods throw AdapterNotWiredError when inert', async () => {
  const cfg = createConfigurationAdapter();
  assert.throws(() => cfg.get('x'), AdapterNotWiredError);
  const idn = createIdentityAdapter();
  assert.throws(() => idn.verify('token'), AdapterNotWiredError);
  // Jobs adapter active methods are async ⇒ they reject (never sync-throw).
  const jobs = createJobsAdapter();
  await assert.rejects(() => jobs.record({ id: 'x', kind: 'interval' }), AdapterNotWiredError);
});

test('pure translators are side-effect-free and shape-correct', () => {
  const idn = createIdentityAdapter();
  assert.deepEqual(idn.toPrincipal({ phone: '965123', type: 'driver', driverId: 7 }), {
    subject: '965123',
    kind: 'driver',
    attributes: { driverId: 7 },
  });

  const health = createHealthAdapter();
  assert.equal(health.toHostHealth({ db: 'ok', cache: 'ok' }).ok, true);
  assert.equal(health.toHostHealth({ db: 'error' }).ok, false);
  assert.deepEqual(health.toReadiness(true), { ready: true });

  const jobs = createJobsAdapter();
  const spec = jobs.toKernelSpec({ id: 'backup', kind: 'interval', intervalMs: 1000 });
  assert.equal(spec.type, 'backup');
  assert.equal(spec.delayMs, 1000);
  assert.deepEqual(spec.payload, { id: 'backup', kind: 'interval', intervalMs: 1000 });
  assert.equal(jobs.expectedStatus('startup'), 'queued');
});

test('injecting a port flips consumed() and delegates to the port', () => {
  const calls = [];
  const fakeConfigPort = {
    get: (k) => {
      calls.push(['get', k]);
      return 'V';
    },
    has: () => true,
  };
  const layer = createPlatformAdapters({ ports: { config: fakeConfigPort } });
  assert.deepEqual(layer.consumed(), ['configuration']);
  assert.equal(layer.configuration.consumed(), true);
  assert.equal(layer.configuration.get('KEY'), 'V');
  assert.deepEqual(calls, [['get', 'KEY']]);
});

test('adapters contain no repository/database access surface', () => {
  // Adapters must be translation-only: they expose no db/repo handles.
  const layer = createPlatformAdapters();
  for (const a of layer.list()) {
    for (const key of Object.keys(a)) {
      assert.ok(
        !/repo|repository|db|sqlite|database/i.test(key),
        `adapter ${a.name} exposes forbidden surface: ${key}`
      );
    }
  }
});
