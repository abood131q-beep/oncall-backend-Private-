'use strict';

/**
 * Enterprise Lifecycle Management Kernel tests (Phase 15.11 / ADR-040) — covers every
 * required category: unit (component value object, state machine, graph), startup
 * ordering, dependency resolution, shutdown, restart, provider (+ future extension
 * points), concurrency, stress, failure injection, and performance, plus
 * events-via-port and the SDK owner-scoped adapter (namespace isolation + capability
 * gates). Deterministic: clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createComponent,
  fromModel,
  computeChecksum,
  STATE,
} = require('../../src/domain/lifecycle/component');
const { validTransition } = require('../../src/domain/lifecycle/states');
const { topoSort, shutdownOrder } = require('../../src/domain/lifecycle/graph');
const { createLifecyclePlatform, providers } = require('../../src/application/lifecycle');
const { createLifecycleMetrics } = require('../../src/application/lifecycle/metrics');
const { toLifecyclePort } = require('../../src/application/lifecycle/sdkAdapter');
const {
  LifecycleValidationError,
  ComponentNotFoundError,
  DependencyError,
  TransitionError,
} = require('../../src/domain/lifecycle/errors');

function makeClock(start = 1000) {
  const box = { now: start };
  const clock = () => box.now;
  clock.set = (n) => (box.now = n);
  clock.adv = (d) => (box.now += d);
  return clock;
}
function recordingPublisher() {
  const events = [];
  return { events, publish: (e) => (events.push(e), Promise.resolve()) };
}
function platform(clock, extra = {}) {
  const pub = recordingPublisher();
  const lk = createLifecyclePlatform({ clock, publisher: pub, ...extra });
  return { lk, L: lk.lifecycle, pub };
}

// ── domain: component value object + state machine ──────────────────────────────────

test('component: create, checksum (excludes state), transitions validated', () => {
  const clock = makeClock(1000);
  const c = createComponent({ componentId: 'db', componentType: 'datastore' }, { clock });
  assert.equal(c.lifecycleState, STATE.REGISTERED);
  assert.ok(c.verifyChecksum());
  const before = c.checksum;
  c.transition(STATE.INITIALIZED, 1100); // state is NOT part of the checksum
  assert.equal(c.checksum, before);
  assert.throws(() => c.transition(STATE.SUSPENDED, 1200), TransitionError); // initialized ↛ suspended
  const re = fromModel(c.toModel(), { clock });
  assert.ok(re.verifyChecksum());
  assert.throws(() => createComponent({}), LifecycleValidationError); // no type
});

test('states: transition validity', () => {
  assert.equal(validTransition('registered', 'initialized'), true);
  assert.equal(validTransition('initialized', 'started'), true);
  assert.equal(validTransition('started', 'suspended'), true);
  assert.equal(validTransition('suspended', 'started'), true);
  assert.equal(validTransition('registered', 'started'), false);
  assert.equal(validTransition('started', 'initialized'), false);
});

// ── domain: dependency graph ─────────────────────────────────────────────────────

test('graph: topological sort (deps first), priority tiebreak, cycle + missing detection', () => {
  const comps = [
    { componentId: 'api', dependencies: ['db', 'cache'], startupPriority: 0 },
    { componentId: 'db', dependencies: [], startupPriority: 10 },
    { componentId: 'cache', dependencies: [], startupPriority: 5 },
  ];
  const s = topoSort(comps);
  assert.equal(s.ok, true);
  assert.deepEqual(s.order, ['db', 'cache', 'api']); // deps first; db before cache by priority
  assert.deepEqual(shutdownOrder(comps).order, ['api', 'cache', 'db']); // reverse
  // cycle
  const cyc = topoSort([
    { componentId: 'a', dependencies: ['b'] },
    { componentId: 'b', dependencies: ['a'] },
  ]);
  assert.equal(cyc.ok, false);
  assert.ok(cyc.cycle.length === 2);
  // missing
  const miss = topoSort([{ componentId: 'a', dependencies: ['ghost'] }]);
  assert.equal(miss.ok, false);
  assert.equal(miss.missing[0].dependency, 'ghost');
});

// ── unit: metrics ─────────────────────────────────────────────────────────────────

test('metrics: gauges + counters + prometheus', () => {
  const m = createLifecycleMetrics({ clock: () => 0 });
  m.bindGauges({ registered: () => 4, running: () => 2 });
  m.recordStarted();
  m.recordRestart();
  m.recordFailedTransition();
  const s = m.snapshot();
  assert.equal(s.registeredComponents, 4);
  assert.equal(s.startedComponents, 2);
  assert.equal(s.restartOperations, 1);
  assert.match(m.prometheus(), /lifecycle_started_components 2/);
  assert.match(m.prometheus(), /lifecycle_failed_transitions_total 1/);
});

// ── provider + future extension points ───────────────────────────────────────────

test('provider: memory persists components; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.putComponent('n', { componentId: 'c1', componentType: 't' });
  assert.equal((await mem.getComponent('n', 'c1')).componentType, 't');
  assert.equal((await mem.listComponents('n')).length, 1);
  assert.equal(await mem.removeComponent('n', 'c1'), true);
  assert.ok(providers.FUTURE_PROVIDERS.includes('postgresql'));
  const p = providers.futureProvider('redis');
  assert.equal(p.planned, true);
  assert.throws(() => p.putComponent('n', {}), /extension point/);
});

// ── startup ordering + dependency-ordered orchestration + events ────────────────────

test('lifecycle: start() runs components in dependency order via hooks; events', async () => {
  const clock = makeClock(1000);
  const { L, pub } = platform(clock);
  const order = [];
  await L.register({
    componentId: 'api',
    componentType: 'svc',
    dependencies: ['db', 'cache'],
    hooks: { start: async () => order.push('api') },
  });
  await L.register({
    componentId: 'db',
    componentType: 'store',
    startupPriority: 10,
    hooks: { start: async () => order.push('db') },
  });
  await L.register({
    componentId: 'cache',
    componentType: 'store',
    startupPriority: 5,
    hooks: { start: async () => order.push('cache') },
  });
  const started = await L.start();
  assert.deepEqual(order, ['db', 'cache', 'api']); // deterministic dependency order
  assert.ok(started.every((c) => c.lifecycleState === STATE.STARTED));
  const types = pub.events.map((e) => e.type);
  assert.ok(
    types.includes('ComponentRegistered') &&
      types.includes('ComponentInitialized') &&
      types.includes('ComponentStarted') &&
      types.includes('LifecycleStateChanged')
  );
  assert.ok(pub.events.every((e) => e.producer === 'lifecycle'));
});

test('lifecycle: dependency resolution blocks starting a component before its dep', async () => {
  const clock = makeClock();
  const { L } = platform(clock);
  await L.register({ componentId: 'db', componentType: 'store' });
  await L.register({ componentId: 'api', componentType: 'svc', dependencies: ['db'] });
  // starting api alone (db not started) is blocked
  await assert.rejects(() => L.start({ componentId: 'api' }), DependencyError);
  // after db is started, api can start
  await L.start({ componentId: 'db' });
  const api = await L.start({ componentId: 'api' });
  assert.equal(api.lifecycleState, STATE.STARTED);
  await assert.rejects(() => L.start({ componentId: 'ghost' }), ComponentNotFoundError);
});

test('lifecycle: a dependency cycle is rejected on start + verify', async () => {
  const clock = makeClock();
  const { L } = platform(clock);
  await L.register({ componentId: 'a', componentType: 't', dependencies: ['b'] });
  await L.register({ componentId: 'b', componentType: 't', dependencies: ['a'] });
  await assert.rejects(() => L.start(), DependencyError);
  const v = await L.verify({ namespace: 'default' });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.reason === 'dependency cycle'));
});

// ── shutdown (graceful, reverse order) ──────────────────────────────────────────────

test('lifecycle: stop() shuts down in reverse dependency order', async () => {
  const clock = makeClock();
  const { L, pub } = platform(clock);
  const order = [];
  await L.register({
    componentId: 'db',
    componentType: 'store',
    hooks: { stop: async () => order.push('db') },
  });
  await L.register({
    componentId: 'api',
    componentType: 'svc',
    dependencies: ['db'],
    hooks: { stop: async () => order.push('api') },
  });
  await L.start();
  await L.stop();
  assert.deepEqual(order, ['api', 'db']); // dependents shut down first
  const stopped = await L.list();
  assert.ok(stopped.every((c) => c.lifecycleState === STATE.STOPPED));
  assert.ok(pub.events.some((e) => e.type === 'ComponentStopped'));
});

// ── restart + suspend/resume ────────────────────────────────────────────────────────

test('lifecycle: restart stops then starts a component', async () => {
  const clock = makeClock();
  const { L, lk, pub } = platform(clock);
  const seq = [];
  await L.register({
    componentId: 'w',
    componentType: 'worker',
    hooks: { start: async () => seq.push('start'), stop: async () => seq.push('stop') },
  });
  await L.start({ componentId: 'w' });
  const r = await L.restart({ componentId: 'w' });
  assert.equal(r.lifecycleState, STATE.STARTED);
  assert.deepEqual(seq, ['start', 'stop', 'start']);
  assert.ok(lk.lifecycle.metrics().restartOperations >= 1);
  assert.ok(pub.events.some((e) => e.type === 'ComponentRestarted'));
});

test('lifecycle: suspend + resume transitions', async () => {
  const clock = makeClock();
  const { L } = platform(clock);
  await L.register({ componentId: 'w', componentType: 'worker' });
  await L.start({ componentId: 'w' });
  assert.equal((await L.suspend({ componentId: 'w' })).lifecycleState, STATE.SUSPENDED);
  assert.equal((await L.resume({ componentId: 'w' })).lifecycleState, STATE.STARTED);
});

// ── status + integrity / verify ────────────────────────────────────────────────────

test('lifecycle: status + verify detect a tampered component', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const { L } = platform(clock, { provider });
  const c = await L.register({ componentId: 'db', componentType: 'store' });
  assert.equal((await L.status({ componentId: 'db' })).componentType, 'store');
  assert.equal((await L.verify({ namespace: 'default' })).ok, true);
  const stored = await provider.getComponent('default', c.componentId);
  await provider.putComponent('default', { ...stored, componentType: 'HIJACKED' });
  const v = await L.verify({ namespace: 'default' });
  assert.equal(v.ok, false);
  await assert.rejects(() => L.start({ componentId: 'db' }), /integrity/);
});

// ── SDK adapter ─────────────────────────────────────────────────────────────────────

test('sdk: owner-scoped port isolates namespaces + gates + no registration', async () => {
  const clock = makeClock();
  const { L } = platform(clock);
  await L.register(
    { componentId: 'w', componentType: 'worker', hooks: { start: async () => {} } },
    { namespace: 'ext.alice' }
  );
  const alice = toLifecyclePort(L, { owner: 'alice', canManage: true });
  await alice.start({ componentId: 'w' });
  assert.equal((await alice.status({ componentId: 'w' })).lifecycleState, STATE.STARTED);
  assert.equal((await alice.list()).length, 1); // only own namespace
  assert.equal(typeof alice.register, 'undefined'); // no registration
  const readOnly = toLifecyclePort(L, { owner: 'ro', canManage: false });
  await assert.rejects(async () => readOnly.start({ componentId: 'w' }), /lifecycle:manage/);
  const noRead = toLifecyclePort(L, { owner: 'nr', canRead: false });
  await assert.rejects(async () => noRead.list(), /lifecycle:read/);
  assert.throws(() => toLifecyclePort(L, {}), /owner required/);
});

// ── failure injection ──────────────────────────────────────────────────────────

test('lifecycle: provider failures are counted and surfaced', async () => {
  const clock = makeClock();
  const failing = {
    name: 'failing',
    putComponent: () => Promise.reject(new Error('db down')),
    getComponent: () => Promise.resolve(null),
    listComponents: () => Promise.resolve([]),
    removeComponent: () => Promise.resolve(false),
    health: () => ({ ok: false }),
  };
  const { L, lk } = platform(clock, { provider: failing });
  await assert.rejects(() => L.register({ componentId: 'c', componentType: 't' }), /db down/);
  assert.ok(lk.lifecycle.metrics().providerFailures >= 1);
  assert.equal((await L.health()).ok, false);
});

// ── concurrency ─────────────────────────────────────────────────────────────────

test('lifecycle: concurrent registrations of distinct components all persist', async () => {
  const clock = makeClock();
  const { L } = platform(clock);
  await Promise.all(
    Array.from({ length: 25 }, (_, i) => L.register({ componentId: 'c' + i, componentType: 't' }))
  );
  assert.equal((await L.list()).length, 25);
});

// ── stress / performance ──────────────────────────────────────────────────────────

test('lifecycle: stress — 500-component chain starts in dependency order, fast', async () => {
  const clock = makeClock();
  const { L } = platform(clock);
  // a linear dependency chain c0 <- c1 <- ... <- c499
  for (let i = 0; i < 500; i++) {
    await L.register({
      componentId: 'c' + i,
      componentType: 't',
      dependencies: i > 0 ? ['c' + (i - 1)] : [],
    });
  }
  const start = Date.now();
  const started = await L.start();
  const elapsed = Date.now() - start;
  assert.equal(started.length, 500);
  assert.equal(started[0].componentId, 'c0'); // root first
  assert.equal(started[499].componentId, 'c499'); // leaf last
  assert.ok(started.every((c) => c.lifecycleState === STATE.STARTED));
  assert.ok(elapsed < 3000, `expected < 3s, took ${elapsed}ms`);
  assert.equal((await L.verify({ namespace: 'default' })).ok, true);
});

test('component checksum is stable across re-hydration', async () => {
  const clock = makeClock();
  const { L, lk } = platform(clock);
  const c = await L.register({ componentId: 'db', componentType: 'store', dependencies: ['x'] });
  const model = await lk.provider.getComponent('default', c.componentId);
  assert.equal(model.checksum, computeChecksum(fromModel(model)));
});
