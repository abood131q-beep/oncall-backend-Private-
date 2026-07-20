'use strict';

/**
 * Enterprise Extension Platform tests (Phase 14.2) — covers every required
 * category: unit (manifest, semver, integrity), dependency resolution,
 * compatibility, permission/sandbox, hook isolation + timeout + circuit breaker,
 * hot reload, rollback, and an end-to-end integration flow.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const semver = require('../../src/domain/extensions/semver');
const { validateManifest, ManifestError } = require('../../src/domain/extensions/manifest');
const integrity = require('../../src/domain/extensions/integrity');
const { createSandbox } = require('../../src/application/extensions/sandbox');
const { createHookBus } = require('../../src/application/extensions/hookBus');
const { resolve } = require('../../src/application/extensions/dependencyResolver');
const { createExtensionPlatform } = require('../../src/application/extensions');

const silent = { warn() {}, error() {}, info() {} };

const goodManifest = (over = {}) => ({
  id: 'surge-pricing',
  name: 'Surge Pricing',
  version: '1.2.0',
  apiVersion: '1.0.0',
  author: 'OnCall Labs',
  description: 'Dynamic surge within authored bounds',
  permissions: ['read:pricing', 'write:pricing'],
  capabilities: ['RidePricing'],
  dependencies: {},
  minimumPlatformVersion: '1.0.0',
  compatibilityRules: {},
  lifecycleHooks: ['BeforeRideRequest'],
  configurationSchema: {},
  healthChecks: [{ name: 'model-loaded' }],
  ...over,
});

// ── semver (unit) ──────────────────────────────────────────────────────────────

test('semver: parse/compare/satisfies for ^ ~ >= exact *', () => {
  assert.equal(semver.compare('1.2.3', '1.2.10'), -1);
  assert.ok(semver.satisfies('1.4.0', '^1.2.0'));
  assert.ok(!semver.satisfies('2.0.0', '^1.2.0'));
  assert.ok(semver.satisfies('1.2.9', '~1.2.3'));
  assert.ok(!semver.satisfies('1.3.0', '~1.2.3'));
  assert.ok(semver.satisfies('9.9.9', '*'));
  assert.ok(semver.satisfies('1.0.0', '>=1.0.0'));
  assert.ok(!semver.satisfies('bad', '^1.0.0'));
});

// ── manifest validation (unit) ──────────────────────────────────────────────

test('manifest: a valid manifest is normalized + frozen', () => {
  const m = validateManifest(goodManifest());
  assert.equal(m.id, 'surge-pricing');
  assert.deepEqual(m.capabilities, ['RidePricing']);
  assert.throws(() => {
    m.permissions.push('x');
  });
});

test('manifest: rejects invalid id/version/unknown permission/capability/hook', () => {
  assert.throws(() => validateManifest(goodManifest({ id: 'X' })), ManifestError);
  assert.throws(() => validateManifest(goodManifest({ version: '1.2' })), ManifestError);
  assert.throws(() => validateManifest(goodManifest({ permissions: ['do:anything'] })), /unknown/);
  assert.throws(
    () => validateManifest(goodManifest({ capabilities: ['WorldDomination'] })),
    /unknown/
  );
  assert.throws(
    () => validateManifest(goodManifest({ lifecycleHooks: ['AfterEverything'] })),
    /unknown/
  );
  try {
    validateManifest({});
  } catch (err) {
    assert.ok(err.errors.length >= 5); // reports ALL problems, not just first
  }
});

// ── integrity (unit) ──────────────────────────────────────────────────────────

test('integrity: checksum verify + signature verifier + compatibility', () => {
  const bytes = 'extension-bundle-bytes';
  const sum = integrity.checksum(bytes);
  assert.ok(integrity.verifyChecksum(bytes, sum).ok);
  assert.ok(!integrity.verifyChecksum(bytes, 'deadbeef').ok);

  // signature required but no verifier → reject
  assert.ok(!integrity.verifySignature(bytes, 'sig', null, { required: true }).ok);
  // injected verifier
  const verifier = { verify: (b, sig) => sig === 'valid-for-' + b };
  assert.ok(integrity.verifySignature(bytes, 'valid-for-' + bytes, verifier).ok);
  assert.ok(!integrity.verifySignature(bytes, 'nope', verifier).ok);

  const m = validateManifest(goodManifest());
  assert.ok(
    integrity.verifyCompatibility(m, { platformVersion: '1.5.0', platformApiRange: '^1.0.0' }).ok
  );
  assert.ok(
    !integrity.verifyCompatibility(m, { platformVersion: '0.9.0', platformApiRange: '^1.0.0' }).ok
  );
  assert.ok(
    !integrity.verifyCompatibility(m, { platformVersion: '1.5.0', platformApiRange: '^2.0.0' }).ok
  );
});

// ── dependency resolution ─────────────────────────────────────────────────────

test('resolver: valid graph yields dependency-first load order', () => {
  const a = validateManifest(
    goodManifest({ id: 'ext-a', capabilities: [], permissions: [], lifecycleHooks: [] })
  );
  const b = validateManifest(
    goodManifest({
      id: 'ext-b',
      dependencies: { 'ext-a': '^1.0.0' },
      capabilities: [],
      permissions: [],
      lifecycleHooks: [],
    })
  );
  const r = resolve([b, a], { platformVersion: '1.0.0', platformApiRange: '^1.0.0' });
  assert.ok(r.ok);
  assert.ok(r.order.indexOf('ext-a') < r.order.indexOf('ext-b')); // dep before dependent
});

test('resolver: missing dep, version mismatch, and cycle are rejected', () => {
  const base = { capabilities: [], permissions: [], lifecycleHooks: [] };
  const miss = validateManifest(
    goodManifest({ id: 'needs-x', dependencies: { 'ext-x': '^1.0.0' }, ...base })
  );
  assert.ok(!resolve([miss], { platformVersion: '1.0.0', platformApiRange: '*' }).ok);

  const a = validateManifest(goodManifest({ id: 'ext-a', version: '1.0.0', ...base }));
  const bMismatch = validateManifest(
    goodManifest({ id: 'ext-b', dependencies: { 'ext-a': '^2.0.0' }, ...base })
  );
  const mm = resolve([a, bMismatch], { platformVersion: '1.0.0', platformApiRange: '*' });
  assert.ok(!mm.ok && mm.errors.some((e) => /requires ext-a@/.test(e)));

  const c1 = validateManifest(
    goodManifest({ id: 'cyc-a', dependencies: { 'cyc-b': '*' }, ...base })
  );
  const c2 = validateManifest(
    goodManifest({ id: 'cyc-b', dependencies: { 'cyc-a': '*' }, ...base })
  );
  const cyc = resolve([c1, c2], { platformVersion: '1.0.0', platformApiRange: '*' });
  assert.ok(!cyc.ok && cyc.errors.some((e) => /cycle/.test(e)));
});

// ── permission / sandbox ──────────────────────────────────────────────────────

test('sandbox: grants only declared+provided permissions; denies everything else', () => {
  const m = validateManifest(goodManifest({ permissions: ['read:pricing'] }));
  const portFactories = {
    'read:pricing': () => ({ getRules: () => 'rules' }),
    'secrets:read': () => ({ get: () => 'TOPSECRET' }), // provided but NOT in manifest
  };
  const sb = createSandbox(m, portFactories, { logger: silent });
  assert.ok(sb.has('read:pricing'));
  assert.equal(sb.context['read:pricing'].getRules(), 'rules');
  assert.ok(!sb.has('secrets:read')); // not declared → not materialized
  assert.equal(sb.context['secrets:read'], undefined); // secrets unreachable
  assert.throws(() => sb.require('secrets:read'), /lacks permission "secrets:read"/);
});

// ── hook isolation + timeout + circuit breaker ───────────────────────────────

test('hookBus: a throwing handler is isolated and fail-open; others still run', async () => {
  const bus = createHookBus({ logger: silent, timeoutMs: 50 });
  const ran = [];
  bus.register(
    'AfterPayment',
    () => {
      throw new Error('bad ext');
    },
    { extId: 'bad' }
  );
  bus.register('AfterPayment', () => ran.push('good'), { extId: 'good' });
  const res = await bus.run('AfterPayment', { paymentRef: 'p1' });
  assert.deepEqual(ran, ['good']);
  assert.equal(res.cancelled, false); // observational hook never cancels
  assert.ok(res.results.some((r) => r.extId === 'bad' && r.ok === false));
});

test('hookBus: a timeout is fail-open (does not cancel a Before* flow)', async () => {
  const bus = createHookBus({ logger: silent, timeoutMs: 10 });
  bus.register('BeforeRideRequest', () => new Promise(() => {}), { extId: 'slow' }); // never resolves
  const res = await bus.run('BeforeRideRequest', { rider: 'u1' });
  assert.equal(res.cancelled, false); // timeout ≠ veto (platform proceeds)
  assert.ok(res.results[0].error === 'timeout');
});

test('hookBus: Before* handler can explicitly cancel the flow', async () => {
  const bus = createHookBus({ logger: silent });
  bus.register('BeforePayment', () => ({ cancel: true, reason: 'fraud suspected' }), {
    extId: 'fraud',
  });
  const res = await bus.run('BeforePayment', { amount: 100 });
  assert.equal(res.cancelled, true);
  assert.match(res.reason, /fraud/);
});

test('hookBus: circuit breaker opens after repeated failures', async () => {
  const bus = createHookBus({
    logger: silent,
    timeoutMs: 20,
    breakerThreshold: 3,
    breakerCooldownMs: 10000,
  });
  bus.register(
    'TripCompleted',
    () => {
      throw new Error('always');
    },
    { extId: 'flaky' }
  );
  for (let i = 0; i < 3; i++) await bus.run('TripCompleted', {});
  assert.ok(bus.breakerOpen('flaky')); // open after threshold
  const res = await bus.run('TripCompleted', {});
  assert.equal(res.results[0].skipped, 'circuit-open'); // now short-circuited
});

// ── integration: install → enable → hook fires through sandbox ────────────────

test('integration: install+enable wires a hook that runs with sandboxed ports', async () => {
  const platform = createExtensionPlatform({
    logger: silent,
    env: { platformVersion: '1.4.0', platformApiRange: '^1.0.0' },
    portFactories: { 'read:pricing': () => ({ base: () => 5 }) },
  });
  const seen = [];
  const pkg = {
    manifest: goodManifest({
      permissions: ['read:pricing'],
      lifecycleHooks: ['BeforeRideRequest'],
    }),
    register(ctx, api) {
      api.registerHook('BeforeRideRequest', (hookCtx) => {
        seen.push({ base: ctx['read:pricing'].base(), rider: hookCtx.rider });
      });
      return () => {};
    },
  };
  await platform.registry.install(pkg);
  await platform.registry.enable('surge-pricing');
  await platform.hookBus.run('BeforeRideRequest', { rider: 'u9' });
  assert.deepEqual(seen, [{ base: 5, rider: 'u9' }]);
  assert.equal(platform.registry.get('surge-pricing').state, 'enabled');
  assert.equal(platform.registry.findByCapability('RidePricing').length, 1);
  // metrics observed the execution
  const snap = platform.metrics.snapshot('surge-pricing');
  assert.ok(snap.executionCount >= 1);
});

test('integration: install rejects invalid manifest and failed integrity', async () => {
  const platform = createExtensionPlatform({
    logger: silent,
    env: { platformVersion: '1.0.0', platformApiRange: '*' },
  });
  await assert.rejects(
    platform.registry.install({ manifest: { id: 'X' }, register: () => {} }),
    ManifestError
  );
  await assert.rejects(
    platform.registry.install({
      manifest: goodManifest(),
      bytes: 'abc',
      checksum: 'wrong',
      register: () => {},
    }),
    /integrity: checksum mismatch/
  );
});

// ── hot reload / disable ──────────────────────────────────────────────────────

test('hot: disable removes hooks; reload re-wires them — no restart', async () => {
  const platform = createExtensionPlatform({
    logger: silent,
    env: { platformVersion: '1.0.0', platformApiRange: '*' },
  });
  let fired = 0;
  const pkg = {
    manifest: goodManifest({ permissions: [], capabilities: [], lifecycleHooks: ['TripStarted'] }),
    register(_ctx, api) {
      api.registerHook('TripStarted', () => fired++);
    },
  };
  await platform.registry.install(pkg);
  await platform.registry.enable('surge-pricing');
  await platform.hookBus.run('TripStarted', {});
  assert.equal(fired, 1);

  await platform.registry.disable('surge-pricing');
  await platform.hookBus.run('TripStarted', {}); // no handler now
  assert.equal(fired, 1);
  assert.equal(platform.registry.get('surge-pricing').state, 'disabled');

  await platform.registry.reload('surge-pricing');
  await platform.hookBus.run('TripStarted', {});
  assert.equal(fired, 2); // re-wired
});

// ── upgrade + rollback ─────────────────────────────────────────────────────────

test('rollback: upgrade to v2 then roll back restores v1 (and enabled state)', async () => {
  const platform = createExtensionPlatform({
    logger: silent,
    env: { platformVersion: '2.0.0', platformApiRange: '*' },
  });
  const mkPkg = (version, tag) => ({
    manifest: goodManifest({
      version,
      permissions: [],
      capabilities: [],
      lifecycleHooks: ['TripCompleted'],
    }),
    register(_ctx, api) {
      api.registerHook('TripCompleted', (c) => c.out.push(tag));
    },
  });
  await platform.registry.install(mkPkg('1.0.0', 'v1'));
  await platform.registry.enable('surge-pricing');
  let out = [];
  await platform.hookBus.run('TripCompleted', { out });
  assert.deepEqual(out, ['v1']);

  await platform.registry.upgrade('surge-pricing', mkPkg('2.0.0', 'v2'));
  assert.equal(platform.registry.get('surge-pricing').manifest.version, '2.0.0');
  out = [];
  await platform.hookBus.run('TripCompleted', { out });
  assert.deepEqual(out, ['v2']); // new version active

  await platform.registry.rollback('surge-pricing');
  assert.equal(platform.registry.get('surge-pricing').manifest.version, '1.0.0');
  out = [];
  await platform.hookBus.run('TripCompleted', { out });
  assert.deepEqual(out, ['v1']); // prior version restored + re-enabled
});

test('metrics: prometheus exposition includes per-extension series', async () => {
  const platform = createExtensionPlatform({
    logger: silent,
    env: { platformVersion: '1.0.0', platformApiRange: '*' },
  });
  await platform.registry.install({
    manifest: goodManifest({
      permissions: [],
      capabilities: [],
      lifecycleHooks: ['UserRegistered'],
    }),
    register: (_c, api) => api.registerHook('UserRegistered', () => {}),
  });
  await platform.registry.enable('surge-pricing');
  await platform.hookBus.run('UserRegistered', {});
  const text = platform.metrics.prometheus();
  assert.match(text, /oncall_extension_executions_total\{extension="surge-pricing"\}/);
  assert.match(text, /oncall_extension_health\{extension="surge-pricing"\}/);
});
