'use strict';

/**
 * Enterprise Compatibility Kernel tests (Phase 15.12 / ADR-041) — covers every required
 * category: unit (contract value object + checksum integrity, pure compatibility
 * evaluation, version resolution, capability negotiation), engine behavior (register /
 * evaluate / negotiate / deprecate / verify / health), deprecation governance,
 * provider (+ future extension points), concurrency, failure injection, and events-via-
 * port plus the SDK owner-scoped adapter (namespace isolation + capability gates).
 * Deterministic: clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createContract,
  fromModel,
  computeChecksum,
  LEVEL,
  DEPRECATION,
} = require('../../src/domain/compatibility/contract');
const compat = require('../../src/domain/compatibility/compatibility');
const {
  createCompatibilityPlatform,
  providers,
  providerPort,
} = require('../../src/application/compatibility');
const { createCompatibilityMetrics } = require('../../src/application/compatibility/metrics');
const { toCompatibilityPort } = require('../../src/application/compatibility/sdkAdapter');
const {
  CompatibilityValidationError,
  ContractNotFoundError,
  NegotiationError,
  IntegrityError,
} = require('../../src/domain/compatibility/errors');
const { PermissionError } = require('../../src/sdk/extensions/errors');

function makeClock(start = 1000) {
  const box = { now: start };
  const clock = () => box.now;
  clock.set = (n) => (box.now = n);
  clock.adv = (d) => (box.now += d);
  return clock;
}
function recordingPublisher() {
  const events = [];
  return { events, publish: (e) => void events.push(e) };
}

// ── Domain: Contract value object + checksum integrity ──────────────────────────────
test('contract: requires component and version', () => {
  assert.throws(() => createContract({ version: '1.0.0' }), CompatibilityValidationError);
  assert.throws(() => createContract({ component: 'x' }), CompatibilityValidationError);
});

test('contract: rejects unknown compatibility level', () => {
  assert.throws(
    () => createContract({ component: 'x', version: '1.0.0', compatibilityLevel: 'weird' }),
    CompatibilityValidationError
  );
});

test('contract: defaults + checksum stable regardless of field order', () => {
  const clock = makeClock();
  const a = createContract(
    { component: 'svc', version: '1.0.0', capabilities: ['b', 'a'], supportedVersions: ['1.0.0'] },
    { clock }
  );
  const b = createContract(
    { component: 'svc', version: '1.0.0', capabilities: ['a', 'b'], supportedVersions: ['1.0.0'] },
    { clock }
  );
  assert.equal(a.compatibilityLevel, LEVEL.BACKWARD);
  assert.equal(a.deprecationStatus, DEPRECATION.ACTIVE);
  assert.equal(a.checksum, b.checksum); // order-independent
  assert.ok(a.verifyChecksum());
});

test('contract: checksum changes on deprecation (includes deprecationStatus)', () => {
  const clock = makeClock();
  const c = createContract({ component: 'svc', version: '1.0.0' }, { clock });
  const before = c.checksum;
  c.deprecate('svc@2', 2000, false);
  assert.notEqual(c.checksum, before);
  assert.equal(c.deprecationStatus, DEPRECATION.DEPRECATED);
  assert.equal(c.replacementContract, 'svc@2');
  assert.ok(c.verifyChecksum());
});

test('contract: fromModel round-trips and detects tampering', () => {
  const clock = makeClock();
  const c = createContract({ component: 'svc', version: '1.2.0', capabilities: ['x'] }, { clock });
  const model = c.toModel();
  assert.ok(fromModel(model, { clock }).verifyChecksum());
  const tampered = { ...model, capabilities: ['x', 'y'] }; // checksum not recomputed
  assert.equal(fromModel(tampered, { clock }).verifyChecksum(), false);
});

// ── Domain: pure compatibility evaluation ───────────────────────────────────────────
test('evaluate: exact version always compatible', () => {
  const c = createContract({ component: 's', version: '2.0.0', capabilities: ['a'] });
  const r = compat.evaluate(c, { version: '2.0.0', capabilities: ['a'] });
  assert.ok(r.compatible && r.versionOk && r.backward && r.forward);
});

test('evaluate: backward level admits older supported versions, rejects newer', () => {
  const c = createContract({
    component: 's',
    version: '2.0.0',
    supportedVersions: ['1.0.0', '1.5.0', '2.0.0'],
    compatibilityLevel: LEVEL.BACKWARD,
  });
  assert.ok(compat.evaluate(c, { version: '1.0.0' }).versionOk); // older supported
  assert.ok(compat.evaluate(c, { version: '1.0.0' }).backward);
  assert.equal(compat.evaluate(c, { version: '3.0.0' }).versionOk, false); // newer, unsupported
});

test('evaluate: forward level admits newer supported versions', () => {
  const c = createContract({
    component: 's',
    version: '1.0.0',
    supportedVersions: ['1.0.0', '2.0.0'],
    compatibilityLevel: LEVEL.FORWARD,
  });
  assert.ok(compat.evaluate(c, { version: '2.0.0' }).versionOk);
  assert.ok(compat.evaluate(c, { version: '2.0.0' }).forward);
  assert.equal(compat.evaluate(c, { version: '0.9.0' }).versionOk, false);
});

test('evaluate: strict level admits only the exact version', () => {
  const c = createContract({
    component: 's',
    version: '2.0.0',
    supportedVersions: ['1.0.0', '2.0.0'],
    compatibilityLevel: LEVEL.STRICT,
  });
  assert.ok(compat.evaluate(c, { version: '2.0.0' }).versionOk);
  assert.equal(compat.evaluate(c, { version: '1.0.0' }).versionOk, false);
});

test('evaluate: full level admits any supported version either direction', () => {
  const c = createContract({
    component: 's',
    version: '2.0.0',
    supportedVersions: ['1.0.0', '2.0.0', '3.0.0'],
    compatibilityLevel: LEVEL.FULL,
  });
  assert.ok(compat.evaluate(c, { version: '1.0.0' }).versionOk);
  assert.ok(compat.evaluate(c, { version: '3.0.0' }).versionOk);
});

test('evaluate: reports missing capabilities and marks incompatible', () => {
  const c = createContract({ component: 's', version: '1.0.0', capabilities: ['a', 'b'] });
  const r = compat.evaluate(c, { version: '1.0.0', capabilities: ['a', 'c'] });
  assert.deepEqual(r.missingCapabilities, ['c']);
  assert.equal(r.compatible, false);
});

test('evaluate: retired contract is never compatible', () => {
  const c = createContract({
    component: 's',
    version: '1.0.0',
    deprecationStatus: DEPRECATION.RETIRED,
  });
  const r = compat.evaluate(c, { version: '1.0.0' });
  assert.equal(r.compatible, false);
  assert.ok(r.deprecated);
});

// ── Domain: version resolution + capability negotiation ─────────────────────────────
test('resolveVersion: picks highest satisfying candidate', () => {
  const c = createContract({
    component: 's',
    version: '2.1.0',
    supportedVersions: ['1.0.0', '2.0.0', '2.1.0'],
  });
  assert.equal(compat.resolveVersion(c, '>=2.0.0'), '2.1.0');
  assert.equal(compat.resolveVersion(c, '1.0.0'), '1.0.0');
  assert.equal(compat.resolveVersion(c, '>=9.0.0'), null);
  assert.equal(compat.resolveVersion(c, null), '2.1.0');
});

test('negotiateCapabilities: intersection with offered set', () => {
  const c = createContract({ component: 's', version: '1.0.0', capabilities: ['a', 'b', 'c'] });
  assert.deepEqual(compat.negotiateCapabilities(c, ['b', 'z']), ['b']);
  assert.deepEqual(compat.negotiateCapabilities(c, []), ['a', 'b', 'c']);
});

// ── Engine: register / evaluate / negotiate / deprecate / verify / health ───────────
test('engine: registerContract persists and emits ContractRegistered', async () => {
  const clock = makeClock();
  const pub = recordingPublisher();
  const { compatibility } = createCompatibilityPlatform({ clock, publisher: pub });
  const c = await compatibility.registerContract({
    contractId: 'billing',
    component: 'billing-api',
    version: '2.0.0',
    supportedVersions: ['1.0.0', '2.0.0'],
    capabilities: ['invoices'],
  });
  assert.equal(c.contractId, 'billing');
  assert.ok(pub.events.some((e) => e.type === 'ContractRegistered'));
  assert.equal((await compatibility.health()).contracts, 1);
});

test('engine: duplicate registration rejected', async () => {
  const { compatibility } = createCompatibilityPlatform({ clock: makeClock() });
  await compatibility.registerContract({ contractId: 'x', component: 'c', version: '1.0.0' });
  await assert.rejects(
    () => compatibility.registerContract({ contractId: 'x', component: 'c', version: '1.0.0' }),
    CompatibilityValidationError
  );
});

test('engine: evaluate returns decision and emits violation when incompatible', async () => {
  const pub = recordingPublisher();
  const { compatibility } = createCompatibilityPlatform({ clock: makeClock(), publisher: pub });
  await compatibility.registerContract({
    contractId: 'svc',
    component: 'svc',
    version: '2.0.0',
    supportedVersions: ['1.0.0', '2.0.0'],
    capabilities: ['a'],
    compatibilityLevel: LEVEL.BACKWARD,
  });
  const ok = await compatibility.evaluate({
    contractId: 'svc',
    version: '1.0.0',
    capabilities: ['a'],
  });
  assert.ok(ok.compatible);
  const bad = await compatibility.evaluate({
    contractId: 'svc',
    version: '9.0.0',
    capabilities: ['a', 'missing'],
  });
  assert.equal(bad.compatible, false);
  assert.ok(pub.events.some((e) => e.type === 'CompatibilityViolationDetected'));
});

test('engine: evaluate requires contractId and reports unknown contract', async () => {
  const { compatibility } = createCompatibilityPlatform({ clock: makeClock() });
  await assert.rejects(() => compatibility.evaluate({}), CompatibilityValidationError);
  await assert.rejects(
    () => compatibility.evaluate({ contractId: 'nope', version: '1.0.0' }),
    ContractNotFoundError
  );
});

test('engine: negotiate resolves version + agreed capabilities and emits event', async () => {
  const pub = recordingPublisher();
  const { compatibility } = createCompatibilityPlatform({ clock: makeClock(), publisher: pub });
  await compatibility.registerContract({
    contractId: 'svc',
    component: 'svc',
    version: '2.1.0',
    supportedVersions: ['1.0.0', '2.0.0', '2.1.0'],
    capabilities: ['a', 'b'],
  });
  const r = await compatibility.negotiate({
    contractId: 'svc',
    version: '>=2.0.0',
    capabilities: ['a', 'z'],
  });
  assert.equal(r.resolvedVersion, '2.1.0');
  assert.deepEqual(r.agreedCapabilities, ['a']);
  assert.deepEqual(r.missingCapabilities, ['z']);
  assert.equal(r.ok, false);
  assert.ok(pub.events.some((e) => e.type === 'CapabilityNegotiated'));
});

test('engine: negotiate strict mode throws NegotiationError', async () => {
  const { compatibility } = createCompatibilityPlatform({ clock: makeClock() });
  await compatibility.registerContract({
    contractId: 'svc',
    component: 'svc',
    version: '1.0.0',
    capabilities: ['a'],
  });
  await assert.rejects(
    () => compatibility.negotiate({ contractId: 'svc', capabilities: ['a', 'b'], strict: true }),
    NegotiationError
  );
});

test('engine: deprecate governs status, sets replacement, emits VersionDeprecated', async () => {
  const pub = recordingPublisher();
  const clock = makeClock();
  const { compatibility } = createCompatibilityPlatform({ clock, publisher: pub });
  await compatibility.registerContract({ contractId: 'old', component: 'svc', version: '1.0.0' });
  const dep = await compatibility.deprecate({
    contractId: 'old',
    replacementContract: 'new',
  });
  assert.equal(dep.deprecationStatus, DEPRECATION.DEPRECATED);
  assert.equal(dep.replacementContract, 'new');
  assert.ok(pub.events.some((e) => e.type === 'VersionDeprecated'));
  const retired = await compatibility.deprecate({ contractId: 'old', retire: true });
  assert.equal(retired.deprecationStatus, DEPRECATION.RETIRED);
});

test('engine: verify single contract emits CompatibilityVerified', async () => {
  const pub = recordingPublisher();
  const { compatibility } = createCompatibilityPlatform({ clock: makeClock(), publisher: pub });
  await compatibility.registerContract({
    contractId: 'svc',
    component: 'svc',
    version: '1.0.0',
    capabilities: ['a'],
  });
  const v = await compatibility.verify({
    contractId: 'svc',
    version: '1.0.0',
    capabilities: ['a'],
  });
  assert.ok(v.ok && v.integrity);
  assert.ok(pub.events.some((e) => e.type === 'CompatibilityVerified'));
});

test('engine: namespace-wide verify detects checksum tampering', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const { compatibility } = createCompatibilityPlatform({ clock, provider });
  await compatibility.registerContract({ contractId: 'svc', component: 'svc', version: '1.0.0' });
  // tamper directly in the provider store
  const model = await provider.getContract('default', 'svc');
  model.capabilities = ['injected'];
  await provider.putContract('default', model);
  const v = await compatibility.verify({});
  assert.equal(v.ok, false);
  assert.equal(v.issues[0].reason, 'checksum mismatch');
});

test('engine: loading a tampered contract throws IntegrityError', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const { compatibility } = createCompatibilityPlatform({ clock, provider });
  await compatibility.registerContract({ contractId: 'svc', component: 'svc', version: '1.0.0' });
  const model = await provider.getContract('default', 'svc');
  model.version = '9.9.9';
  await provider.putContract('default', model);
  await assert.rejects(
    () => compatibility.evaluate({ contractId: 'svc', version: '1.0.0' }),
    IntegrityError
  );
});

// ── Provider port + future extension points ─────────────────────────────────────────
test('providerPort: assertProvider enforces contract', () => {
  assert.throws(() => providerPort.assertProvider({ name: 'incomplete' }), /must implement/);
  assert.throws(() => providerPort.assertProvider(null), /must expose a name/);
});

test('providerPort: future providers are declared extension points, not implemented', () => {
  assert.ok(providerPort.FUTURE_PROVIDERS.includes('postgresql'));
  const p = providerPort.futureProvider('redis');
  assert.equal(p.planned, true);
  assert.throws(() => p.putContract('ns', {}), /extension point/);
  assert.throws(() => providerPort.futureProvider('unknown'), /not a recognized/);
});

// ── Concurrency: registration is atomic per namespace ───────────────────────────────
test('concurrency: parallel duplicate registrations yield exactly one success', async () => {
  const { compatibility } = createCompatibilityPlatform({ clock: makeClock() });
  const attempts = Array.from({ length: 20 }, () =>
    compatibility
      .registerContract({ contractId: 'race', component: 'svc', version: '1.0.0' })
      .then(() => 'ok')
      .catch(() => 'fail')
  );
  const results = await Promise.all(attempts);
  assert.equal(results.filter((r) => r === 'ok').length, 1);
  assert.equal((await compatibility.health()).contracts, 1);
});

// ── Failure injection: provider errors surface + increment metric ───────────────────
test('failure: provider error increments providerFailures metric', async () => {
  const metrics = createCompatibilityMetrics({ clock: makeClock() });
  const badProvider = {
    name: 'bad',
    putContract: () => Promise.reject(new Error('disk full')),
    getContract: () => Promise.resolve(null),
    listContracts: () => Promise.resolve([]),
    removeContract: () => Promise.resolve(false),
    health: () => ({ ok: false }),
  };
  const { compatibility } = createCompatibilityPlatform({
    clock: makeClock(),
    provider: badProvider,
    metrics,
  });
  await assert.rejects(() =>
    compatibility.registerContract({ contractId: 'x', component: 'c', version: '1.0.0' })
  );
  assert.ok(metrics.snapshot().providerFailures >= 1);
});

// ── Metrics + Prometheus exposition ─────────────────────────────────────────────────
test('metrics: prometheus exposition includes kernel gauges', async () => {
  const metrics = createCompatibilityMetrics({ clock: makeClock() });
  const { compatibility } = createCompatibilityPlatform({ clock: makeClock(), metrics });
  await compatibility.registerContract({ contractId: 'x', component: 'c', version: '1.0.0' });
  await compatibility.evaluate({ contractId: 'x', version: '1.0.0' });
  const text = metrics.prometheus();
  assert.match(text, /compatibility_registered_contracts/);
  assert.match(text, /compatibility_evaluations_total/);
  assert.match(text, /compatibility_uptime_ms/);
});

// ── SDK adapter: namespace isolation + capability gates ─────────────────────────────
test('sdk: adapter forces ext.<owner> namespace and hides admin methods', async () => {
  const { compatibility } = createCompatibilityPlatform({ clock: makeClock() });
  const port = toCompatibilityPort(compatibility, {
    owner: 'acme',
    canRead: true,
    canVerify: true,
  });
  assert.equal(typeof port.registerContract, 'undefined');
  assert.equal(typeof port.deprecate, 'undefined');
  // register into the owner namespace via the raw engine, then read via the scoped port
  await compatibility.registerContract(
    { contractId: 'c1', component: 'svc', version: '1.0.0', capabilities: ['a'] },
    { namespace: 'ext.acme' }
  );
  const list = await port.list();
  assert.equal(list.length, 1);
  const dec = await port.evaluate({ contractId: 'c1', version: '1.0.0', capabilities: ['a'] });
  assert.ok(dec.compatible);
});

test('sdk: capability gates enforced', async () => {
  const { compatibility } = createCompatibilityPlatform({ clock: makeClock() });
  const noRead = toCompatibilityPort(compatibility, { owner: 'a', canRead: false });
  assert.throws(() => noRead.list(), PermissionError);
  assert.throws(() => noRead.evaluate({ contractId: 'x' }), PermissionError);
  const noVerify = toCompatibilityPort(compatibility, {
    owner: 'a',
    canRead: true,
    canVerify: false,
  });
  assert.throws(() => noVerify.verify({ contractId: 'x' }), PermissionError);
});

test('sdk: adapter requires owner', () => {
  const { compatibility } = createCompatibilityPlatform({ clock: makeClock() });
  assert.throws(() => toCompatibilityPort(compatibility, {}), /owner required/);
});
