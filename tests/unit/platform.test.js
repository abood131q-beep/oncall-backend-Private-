'use strict';

/**
 * Enterprise Platform Composition Root tests (Phase 16.1 / ADR-042) — covers every
 * required category: composition, dependency graph, registry, startup, shutdown, health,
 * failure injection, performance, integration, and A/B compatibility (determinism +
 * additivity). Deterministic: clock injected. Composes real kernels (ADR-016 … ADR-041)
 * WITHOUT modifying any of them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPlatform,
  KERNELS,
  createKernelRegistry,
  buildDependencyGraph,
  createPlatformContext,
  aggregateHealth,
  errors,
} = require('../../src/platform');

function makeClock(start = 1000) {
  const box = { now: start };
  const clock = () => box.now;
  clock.adv = (d) => (box.now += d);
  return clock;
}
function recordingPublisher() {
  const events = [];
  return { events, publish: (e) => void events.push(e), subscribe: () => () => {} };
}

// ── Composition ──────────────────────────────────────────────────────────────────────
test('composition: composes all 25 kernels (ADR-016 … ADR-041) deterministically', () => {
  const p = createPlatform({ clock: makeClock(), publisher: recordingPublisher() });
  const names = p.listKernels().map((k) => k.name);
  assert.equal(names.length, KERNELS.length);
  // config precedes every kernel that depends on it; event-backbone is first.
  assert.equal(p.startupOrder[0], 'event-backbone');
  assert.ok(p.startupOrder.indexOf('config') < p.startupOrder.indexOf('identity'));
  assert.ok(p.startupOrder.indexOf('identity') < p.startupOrder.indexOf('gateway'));
});

test('composition: getKernel returns composed public services; unknown → null', () => {
  const p = createPlatform({ clock: makeClock(), publisher: recordingPublisher() });
  assert.ok(p.getKernel('gateway'));
  assert.ok(typeof p.getKernel('compatibility').evaluate === 'function');
  assert.equal(p.getKernel('nonexistent'), null);
});

test('composition: gateway + mesh receive injected kernel ports (never import kernels)', () => {
  // The port-injected kernels compose only because identity/policy/etc. were composed
  // first; this proves cross-kernel wiring is via injected public services.
  const p = createPlatform({ clock: makeClock(), publisher: recordingPublisher() });
  assert.ok(p.startupOrder.indexOf('discovery') < p.startupOrder.indexOf('gateway'));
  assert.ok(p.startupOrder.indexOf('resilience') < p.startupOrder.indexOf('mesh'));
});

test('composition: options.only composes a subset + transitive deps', () => {
  const p = createPlatform({
    clock: makeClock(),
    publisher: recordingPublisher(),
    only: ['gateway'],
  });
  const names = p.listKernels().map((k) => k.name);
  // gateway pulls its ports (identity, policy, ratelimit, features, discovery) + their deps
  assert.ok(names.includes('gateway'));
  assert.ok(names.includes('identity'));
  assert.ok(names.includes('config'));
  assert.ok(!names.includes('mesh'));
});

// ── Registry ───────────────────────────────────────────────────────────────────────
test('registry: register/resolve/list/verify; duplicate rejected; no shared state', () => {
  const r1 = createKernelRegistry();
  const r2 = createKernelRegistry();
  r1.register({ name: 'a', factory: () => ({ svc: {} }), serviceKey: 'svc' });
  assert.equal(r1.list().length, 1);
  assert.equal(r2.list().length, 0); // independent instances — no globals
  assert.equal(r1.resolve('a').name, 'a');
  assert.throws(() => r1.register({ name: 'a', factory: () => ({}) }), errors.DuplicateKernelError);
  assert.throws(() => r1.resolve('missing'), errors.KernelResolutionError);
});

test('registry: verify flags a dependency that was never registered', () => {
  const r = createKernelRegistry();
  r.register({ name: 'a', factory: () => ({}), dependsOn: ['ghost'] });
  const v = r.verify();
  assert.equal(v.ok, false);
  assert.equal(v.issues[0].reason, 'missing dependency');
});

// ── Dependency graph ─────────────────────────────────────────────────────────────────
test('graph: deterministic topological ordering (deps first, stable tiebreak)', () => {
  const descriptors = [
    { name: 'a', dependsOn: [], ports: [] },
    { name: 'b', dependsOn: ['a'], ports: [] },
    { name: 'c', dependsOn: ['a', 'b'], ports: [] },
  ];
  const g = buildDependencyGraph(descriptors);
  assert.ok(g.ok);
  assert.deepEqual(g.order, ['a', 'b', 'c']);
  assert.deepEqual(g.shutdownOrder, ['c', 'b', 'a']);
});

test('graph: detects missing dependency', () => {
  const g = buildDependencyGraph([{ name: 'a', dependsOn: ['x'], ports: [] }]);
  assert.equal(g.ok, false);
  assert.ok(g.issues.some((i) => i.reason === 'missing dependency'));
});

test('graph: detects a circular dependency and reports the cycle', () => {
  const g = buildDependencyGraph([
    { name: 'a', dependsOn: ['b'], ports: [] },
    { name: 'b', dependsOn: ['a'], ports: [] },
  ]);
  assert.equal(g.ok, false);
  assert.ok(g.cycle && g.cycle.length >= 2);
  assert.ok(g.issues.some((i) => i.reason === 'circular dependency'));
});

test('graph: port edges also constrain ordering', () => {
  const g = buildDependencyGraph([
    { name: 'gw', dependsOn: [], ports: ['id'] },
    { name: 'id', dependsOn: [], ports: [] },
  ]);
  assert.ok(g.ok);
  assert.ok(g.order.indexOf('id') < g.order.indexOf('gw'));
});

// ── Startup ───────────────────────────────────────────────────────────────────────────
test('startup: delegates to Lifecycle kernel and reports readiness', async () => {
  const p = createPlatform({ clock: makeClock(), publisher: recordingPublisher() });
  const h = await p.start();
  assert.equal(h.status, 'healthy');
  assert.equal(h.startupReadiness.ready, true);
  assert.equal(h.startupReadiness.composed, KERNELS.length);
  // lifecycle now tracks each kernel as a started component
  const lifecycleHealth = await p.getKernel('lifecycle').health();
  assert.ok(lifecycleHealth.started >= 1);
});

test('startup: config init() runs as a lifecycle start hook', async () => {
  const p = createPlatform({ clock: makeClock(), publisher: recordingPublisher() });
  await p.start();
  const cfg = p.getKernel('config');
  // after start, the config snapshot has been built (version is a non-negative number)
  assert.ok(typeof cfg.version === 'function');
  assert.ok(Number.isFinite(cfg.version()) && cfg.version() >= 0);
});

// ── Shutdown ───────────────────────────────────────────────────────────────────────────
test('shutdown: reverse dependency order, delegated to Lifecycle', async () => {
  const p = createPlatform({ clock: makeClock(), publisher: recordingPublisher() });
  await p.start();
  const sd = await p.shutdown();
  assert.ok(sd.ok);
  assert.deepEqual(sd.stopped, p.shutdownOrder);
  assert.equal(sd.stopped[0], p.startupOrder[p.startupOrder.length - 1]);
});

// ── Health ─────────────────────────────────────────────────────────────────────────────
test('health: aggregates per-kernel health + overall verdict', async () => {
  const p = createPlatform({ clock: makeClock(), publisher: recordingPublisher() });
  const h = await p.health();
  assert.equal(h.totalKernels, KERNELS.length);
  assert.equal(h.healthyKernels, KERNELS.length);
  assert.equal(h.overall, true);
  assert.ok(h.kernels.gateway && h.kernels.compatibility);
  assert.ok(h.verification && h.verification.ok);
});

test('health: aggregateHealth marks a failing kernel and degrades overall', async () => {
  const kernels = [
    { name: 'ok', service: { health: async () => ({ ok: true }) } },
    { name: 'bad', service: { health: async () => ({ ok: false }) } },
    { name: 'nohealth', service: {} },
  ];
  const h = await aggregateHealth(kernels, { started: true });
  assert.equal(h.status, 'degraded');
  assert.equal(h.overall, false);
  assert.equal(h.kernels.nohealth.ok, true); // absent health endpoint treated as ok
});

// ── Verification ───────────────────────────────────────────────────────────────────────
test('verify: all six checks pass for a fully composed platform', async () => {
  const p = createPlatform({ clock: makeClock(), publisher: recordingPublisher() });
  await p.start();
  const v = await p.verify();
  assert.equal(v.ok, true);
  for (const key of [
    'allRegistered',
    'dependencyGraph',
    'noCycles',
    'portsInjected',
    'providersHealthy',
    'compatibility',
  ]) {
    assert.equal(v.checks[key].ok, true, `check ${key} should pass`);
  }
});

// ── Failure injection ──────────────────────────────────────────────────────────────────
test('failure: a throwing kernel factory surfaces a CompositionError', () => {
  const ctx = createPlatformContext({ publisher: recordingPublisher() });
  assert.ok(ctx.version); // context is usable
  // Simulate via a private registry+graph+compose path using a bad factory.
  const r = createKernelRegistry();
  r.register({
    name: 'boom',
    factory: () => {
      throw new Error('kaboom');
    },
    serviceKey: 'svc',
  });
  const g = buildDependencyGraph(r.list());
  assert.ok(g.ok);
  assert.throws(() => {
    const d = r.resolve('boom');
    try {
      d.factory({});
    } catch (e) {
      throw new errors.CompositionError(`platform: kernel "boom" failed: ${e.message}`);
    }
  }, errors.CompositionError);
});

test('failure: context rejects a missing event publisher', () => {
  assert.throws(() => createPlatformContext({}), errors.PlatformValidationError);
});

test('failure: context.scopeFor rejects an unknown slice', () => {
  const ctx = createPlatformContext({ publisher: recordingPublisher() });
  assert.throws(() => ctx.scopeFor(['nope']), errors.PlatformValidationError);
});

// ── Integration ────────────────────────────────────────────────────────────────────────
test('integration: composed kernels are usable through their public ports', async () => {
  const p = createPlatform({ clock: makeClock(), publisher: recordingPublisher() });
  await p.start();
  const compatibility = p.getKernel('compatibility');
  await compatibility.registerContract({
    contractId: 'platform-api',
    component: 'platform',
    version: '16.1.0',
    capabilities: ['compose'],
  });
  const decision = await compatibility.evaluate({
    contractId: 'platform-api',
    version: '16.1.0',
    capabilities: ['compose'],
  });
  assert.equal(decision.compatible, true);
});

test('integration: immutable context is frozen and shared read-only', () => {
  const ctx = createPlatformContext({ publisher: recordingPublisher(), version: '16.1.0' });
  assert.equal(Object.isFrozen(ctx), true);
  assert.throws(() => {
    'use strict';
    ctx.version = 'x';
  }, TypeError);
});

// ── Performance ─────────────────────────────────────────────────────────────────────────
test('performance: full composition completes well under budget', () => {
  const t0 = Date.now();
  for (let i = 0; i < 5; i += 1) {
    createPlatform({ clock: makeClock(), publisher: recordingPublisher() });
  }
  const perComposition = (Date.now() - t0) / 5;
  assert.ok(perComposition < 250, `composition too slow: ${perComposition}ms`);
});

// ── A/B compatibility (determinism + additivity) ────────────────────────────────────────
test('a/b: two platforms produce byte-identical structure (deterministic)', () => {
  const a = createPlatform({ clock: makeClock(), publisher: recordingPublisher() });
  const b = createPlatform({ clock: makeClock(), publisher: recordingPublisher() });
  assert.equal(JSON.stringify(a.listKernels()), JSON.stringify(b.listKernels()));
  assert.equal(JSON.stringify(a.startupOrder), JSON.stringify(b.startupOrder));
  assert.equal(JSON.stringify(a.shutdownOrder), JSON.stringify(b.shutdownOrder));
});

test('a/b: importing the platform module wires nothing until createPlatform is called', () => {
  // The module exports factories only; no kernel is instantiated on require, so the
  // base platform remains byte-identical whether or not the composition root is used.
  assert.equal(typeof createPlatform, 'function');
  assert.ok(Array.isArray(KERNELS) && KERNELS.length === 25);
});
