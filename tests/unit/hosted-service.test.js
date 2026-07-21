'use strict';

/**
 * hosted-service.test.js — Phase 17.2
 *
 * Verifies OnCallAppService + Host registration + both boot modes, using an INJECTED fake
 * application so the full Host/Runtime lifecycle is exercised without the DB-backed app.
 *
 * Covered:
 *   • §2 contract conformance (9 methods) + ready()
 *   • start()/stop() delegate to the application exactly once; readiness transitions
 *   • Host registration (assertServiceContract) + host.start()/stop() lifecycle
 *   • full Enterprise boot (bootstrap → createHost → register → host.start)
 *   • graceful shutdown ordering (service stops before runtime)
 *   • boot-mode selection by PLATFORM_ENABLED / PLATFORM_HOST flags
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOnCallAppService } = require('../../src/hosted-service/onCallAppService');
const { createPlatformAdapters } = require('../../src/platform-adapters');
const { assertServiceContract, CONTRACT_METHODS } = require('../../src/host');
const { selectBootMode } = require('../../src/enterprise/mode');
const { bootEnterprise } = require('../../src/enterprise');

const quietLogger = { info() {}, warn() {}, error() {}, success() {}, fatal() {} };

/** A fake OnCall application: no sqlite, no HTTP; records lifecycle calls. */
function makeFakeApp() {
  const calls = [];
  let listening = false;
  return {
    calls,
    port: 3999,
    listening: () => listening,
    start: async () => {
      calls.push('start');
      listening = true;
      return { listening: true, port: 3999 };
    },
    stop: async () => {
      calls.push('stop');
      listening = false;
      return { stopped: true };
    },
  };
}

function makeService(fake, extra = {}) {
  return createOnCallAppService({
    logger: quietLogger,
    version: '1.0.0',
    adapters: createPlatformAdapters(),
    createApplication: () => fake,
    ...extra,
  });
}

test('implements the full ADR-044 §2 hosted-service contract (+ ready)', () => {
  const svc = makeService(makeFakeApp());
  for (const m of CONTRACT_METHODS) assert.equal(typeof svc[m], 'function', `missing ${m}()`);
  assert.equal(typeof svc.ready, 'function');
  assert.doesNotThrow(() => assertServiceContract(svc));
  assert.equal(svc.id(), 'oncall-backend');
  assert.equal(svc.name(), 'OnCall Backend');
  assert.equal(svc.version(), '1.0.0');
  assert.deepEqual(svc.dependencies(), []);
});

test('start()/stop() delegate to the application and flip readiness', async () => {
  const fake = makeFakeApp();
  const svc = makeService(fake);

  assert.deepEqual(await svc.ready(), { ready: false });
  await svc.start();
  assert.deepEqual(fake.calls, ['start']);
  assert.deepEqual(await svc.ready(), { ready: true });
  assert.equal((await svc.health()).ok, true);
  assert.equal((await svc.health()).state, 'started');

  await svc.stop();
  assert.deepEqual(fake.calls, ['start', 'stop']);
  assert.deepEqual(await svc.ready(), { ready: false });
});

test('start()/stop() are idempotent', async () => {
  const fake = makeFakeApp();
  const svc = makeService(fake);
  await svc.start();
  const again = await svc.start();
  assert.equal(again.alreadyStarted, true);
  await svc.stop();
  const stopAgain = await svc.stop();
  assert.equal(stopAgain.alreadyStopped, true);
  assert.deepEqual(fake.calls, ['start', 'stop']); // exactly once each
});

test('metadata reports Phase 17.2 inert-adapter posture', () => {
  const svc = makeService(makeFakeApp());
  const meta = svc.metadata();
  assert.deepEqual(meta.needs, []);
  assert.equal(meta.phase, '17.2');
  assert.deepEqual(meta.kernelsConsumed, []);
  assert.equal(meta.adapters.length, 12);
});

test('full Enterprise boot: bootstrap → host → register → start → stop', async () => {
  const fake = makeFakeApp();
  const { host, runtime, service, adapters } = await bootEnterprise({
    logger: quietLogger,
    createApplication: () => fake,
    installSignalHandlers: false,
  });

  // registered as the single hosted service
  assert.deepEqual(
    host.listServices().map((d) => d.id),
    ['oncall-backend']
  );
  // app was started via the host
  assert.deepEqual(fake.calls, ['start']);
  assert.deepEqual(await service.ready(), { ready: true });

  // health + verify are green
  const health = await host.health();
  assert.equal(health.status, 'healthy');
  assert.equal(health.services['oncall-backend'].ok, true);
  assert.equal((await host.verify()).ok, true);

  // adapters remained inert throughout
  assert.deepEqual(adapters.consumed(), []);
  assert.equal((await runtime.ready()).ready, true);

  // graceful shutdown: service stops, then runtime
  const result = await host.stop();
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls, ['start', 'stop']);
});

test('boot-mode selection is controlled only by PLATFORM_ENABLED + PLATFORM_HOST', () => {
  assert.equal(selectBootMode({ PLATFORM_ENABLED: '1', PLATFORM_HOST: '1' }), 'enterprise');
  assert.equal(selectBootMode({ PLATFORM_ENABLED: '1' }), 'legacy');
  assert.equal(selectBootMode({ PLATFORM_HOST: '1' }), 'legacy');
  assert.equal(selectBootMode({}), 'legacy');
  // strict '1' only — other truthy-looking values stay legacy
  assert.equal(selectBootMode({ PLATFORM_ENABLED: 'true', PLATFORM_HOST: 'true' }), 'legacy');
  assert.equal(selectBootMode({ PLATFORM_ENABLED: '1', PLATFORM_HOST: '0' }), 'legacy');
});
