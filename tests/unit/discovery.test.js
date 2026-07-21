'use strict';

/**
 * Enterprise Service Discovery Kernel tests (Phase 15.5 / ADR-034) — covers every
 * required category: unit (service value object, checksum, selection primitives),
 * discovery, resolution, capability lookup, health selection, provider (+ future
 * extension points), concurrency, stress, failure injection, and performance, plus
 * events-via-port and the SDK owner-scoped adapter (namespace isolation + capability
 * gates). Deterministic: clock injected, hashing content-based.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createService,
  fromModel,
  computeChecksum,
  HEALTH,
} = require('../../src/domain/discovery/service');
const { filter, selectOne, matchService } = require('../../src/domain/discovery/selection');
const { createDiscoveryPlatform, providers } = require('../../src/application/discovery');
const { createDiscoveryMetrics } = require('../../src/application/discovery/metrics');
const { createDiscoveryCache } = require('../../src/application/discovery/cache');
const { toDiscoveryPort } = require('../../src/application/discovery/sdkAdapter');
const {
  DiscoveryValidationError,
  ServiceNotFoundError,
} = require('../../src/domain/discovery/errors');

function makeClock(start = 1000) {
  const box = { now: start };
  const clock = () => box.now;
  clock.set = (n) => (box.now = n);
  return clock;
}
function recordingPublisher() {
  const events = [];
  return { events, publish: (e) => (events.push(e), Promise.resolve()) };
}
function platform(clock, extra = {}) {
  const pub = recordingPublisher();
  const dk = createDiscoveryPlatform({ clock, publisher: pub, ...extra });
  return { dk, D: dk.discovery, pub };
}

// ── domain: service value object + checksum ───────────────────────────────────────

test('service: create, checksum (excludes health), endpoint integrity', () => {
  const clock = makeClock(1000);
  const s = createService(
    { serviceName: 'trips', endpoint: 'http://a:1', capabilities: ['book'], version: '1.2.0' },
    { clock }
  );
  assert.equal(s.healthStatus, HEALTH.UNKNOWN);
  assert.ok(s.verifyChecksum());
  assert.ok(s.verifyEndpoint());
  const before = s.checksum;
  s.setHealth('healthy', 1100); // health is NOT part of the checksum
  assert.equal(s.checksum, before);
  const re = fromModel(s.toModel(), { clock });
  assert.ok(re.verifyChecksum());
  assert.throws(() => createService({ endpoint: 'x' }), DiscoveryValidationError); // no name
  assert.throws(() => createService({ serviceName: 'x' }), DiscoveryValidationError); // no endpoint
});

// ── domain: selection primitives ──────────────────────────────────────────────────

test('selection: match by capability, version range, tags, metadata', () => {
  const clock = makeClock();
  const s = createService(
    {
      serviceName: 'trips',
      endpoint: 'http://a:1',
      version: '1.4.0',
      capabilities: ['book', 'cancel'],
      tags: ['prod'],
      metadata: { region: 'us' },
    },
    { clock }
  ).toModel();
  assert.equal(matchService(s, { serviceName: 'trips', capabilities: ['book'] }), true);
  assert.equal(matchService(s, { capabilities: ['refund'] }), false); // missing capability
  assert.equal(matchService(s, { version: '>=1.2.0' }), true);
  assert.equal(matchService(s, { version: '>=2.0.0' }), false);
  assert.equal(matchService(s, { tags: ['prod'] }), true);
  assert.equal(matchService(s, { metadata: { region: 'eu' } }), false);
});

test('selection: priority + weight ordering; deterministic weighted pick', () => {
  const mk = (id, priority, weight) => ({
    serviceId: id,
    instanceId: id,
    serviceName: 's',
    priority,
    weight,
    healthStatus: 'healthy',
    capabilities: [],
    tags: [],
    metadata: {},
    version: '1.0.0',
  });
  const ordered = filter([mk('a', 1, 1), mk('b', 5, 2), mk('c', 5, 8)], { serviceName: 's' });
  assert.deepEqual(
    ordered.map((s) => s.serviceId),
    ['c', 'b', 'a']
  ); // priority desc, weight desc
  // weighted pick within the top tier (b+c, weights 2+8) is stable for a fixed key
  const r1 = selectOne(ordered, { serviceName: 's', key: 'user-1' });
  const r2 = selectOne(ordered, { serviceName: 's', key: 'user-1' });
  assert.equal(r1.selected.serviceId, r2.selected.serviceId); // deterministic
  assert.ok(['b', 'c'].includes(r1.selected.serviceId));
  // no key → first of tier (highest weight)
  assert.equal(selectOne(ordered, { serviceName: 's' }).selected.serviceId, 'c');
});

// ── unit: metrics + cache ─────────────────────────────────────────────────────────

test('metrics: gauges + counters + prometheus', () => {
  const m = createDiscoveryMetrics({ clock: () => 0 });
  m.bindGauges({ services: () => 2, instances: () => 5 });
  m.recordDiscovery();
  m.recordResolution();
  m.recordCacheHit();
  const s = m.snapshot();
  assert.equal(s.registeredServices, 2);
  assert.equal(s.registeredInstances, 5);
  assert.equal(s.resolutions, 1);
  assert.match(m.prometheus(), /discovery_registered_instances 5/);
  assert.match(m.prometheus(), /discovery_resolutions_total 1/);
});

test('cache: per-namespace hit/miss + invalidation', () => {
  const c = createDiscoveryCache({ maxNamespaces: 2 });
  assert.equal(c.get('a'), undefined); // miss
  c.set('a', [{ x: 1 }]);
  assert.deepEqual(c.get('a'), [{ x: 1 }]); // hit
  c.invalidate('a');
  assert.equal(c.get('a'), undefined);
});

// ── provider + future extension points ───────────────────────────────────────────

test('provider: memory stores service defs; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.putService('n', { serviceId: 's1', serviceName: 'x' });
  assert.equal((await mem.getService('n', 's1')).serviceName, 'x');
  assert.equal((await mem.listServices('n')).length, 1);
  assert.equal(await mem.removeService('n', 's1'), true);
  assert.ok(providers.FUTURE_PROVIDERS.includes('consul'));
  assert.ok(providers.FUTURE_PROVIDERS.includes('kubernetes'));
  const p = providers.futureProvider('etcd');
  assert.equal(p.planned, true);
  assert.throws(() => p.putService('n', {}), /extension point/);
});

// ── register + discover + events ────────────────────────────────────────────────────

test('discovery: register + discover by capability; events', async () => {
  const clock = makeClock(1000);
  const { D, pub } = platform(clock);
  await D.register({
    serviceName: 'trips',
    endpoint: 'http://a:1',
    capabilities: ['book'],
    healthStatus: 'healthy',
  });
  await D.register({
    serviceName: 'trips',
    endpoint: 'http://b:1',
    capabilities: ['book', 'cancel'],
    healthStatus: 'healthy',
  });
  await D.register({
    serviceName: 'billing',
    endpoint: 'http://c:1',
    capabilities: ['charge'],
    healthStatus: 'healthy',
  });
  const byCap = await D.discover({ capabilities: ['cancel'] });
  assert.equal(byCap.count, 1);
  assert.equal(byCap.candidates[0].endpoint, 'http://b:1');
  const byName = await D.discover({ serviceName: 'trips' });
  assert.equal(byName.count, 2);
  assert.ok(pub.events.some((e) => e.type === 'ServiceRegistered'));
  assert.ok(pub.events.every((e) => e.producer === 'discovery'));
});

test('discovery: re-register same serviceId emits ServiceUpdated + health change', async () => {
  const clock = makeClock();
  const { D, dk, pub } = platform(clock);
  const s = await D.register({
    serviceName: 'trips',
    endpoint: 'http://a:1',
    healthStatus: 'healthy',
  });
  await D.register({
    serviceId: s.serviceId,
    serviceName: 'trips',
    endpoint: 'http://a:1',
    healthStatus: 'degraded',
  });
  assert.ok(pub.events.some((e) => e.type === 'ServiceUpdated'));
  assert.ok(dk.discovery.metrics().healthChanges >= 1);
});

// ── resolution + health-aware selection ─────────────────────────────────────────────

test('discovery: resolve selects a healthy instance deterministically; events', async () => {
  const clock = makeClock(1000);
  const { D, pub } = platform(clock);
  await D.register({
    serviceName: 'trips',
    instanceId: 'i1',
    endpoint: 'http://a:1',
    healthStatus: 'healthy',
    weight: 1,
  });
  await D.register({
    serviceName: 'trips',
    instanceId: 'i2',
    endpoint: 'http://b:1',
    healthStatus: 'healthy',
    weight: 1,
  });
  const r1 = await D.resolve({ serviceName: 'trips', key: 'user-1' });
  const r2 = await D.resolve({ serviceName: 'trips', key: 'user-1' });
  assert.equal(r1.selected.instanceId, r2.selected.instanceId); // deterministic per key
  assert.ok(pub.events.some((e) => e.type === 'ServiceResolved'));
});

test('discovery: resolve excludes failed instances; unavailable when none healthy', async () => {
  const clock = makeClock();
  const { D, dk, pub } = platform(clock);
  await D.register({
    serviceName: 'trips',
    instanceId: 'i1',
    endpoint: 'http://a:1',
    healthStatus: 'failed',
  });
  await assert.rejects(() => D.resolve({ serviceName: 'trips' }), ServiceNotFoundError);
  assert.ok(pub.events.some((e) => e.type === 'ServiceUnavailable'));
  assert.ok(dk.discovery.metrics().unavailable >= 1);
  // add a healthy one → now resolvable, and it must be the healthy instance
  await D.register({
    serviceName: 'trips',
    instanceId: 'i2',
    endpoint: 'http://b:1',
    healthStatus: 'healthy',
  });
  const r = await D.resolve({ serviceName: 'trips' });
  assert.equal(r.selected.instanceId, 'i2');
});

test('discovery: priority tier wins in resolve', async () => {
  const clock = makeClock();
  const { D } = platform(clock);
  await D.register({
    serviceName: 's',
    instanceId: 'lo',
    endpoint: 'http://a:1',
    healthStatus: 'healthy',
    priority: 1,
  });
  await D.register({
    serviceName: 's',
    instanceId: 'hi',
    endpoint: 'http://b:1',
    healthStatus: 'healthy',
    priority: 10,
  });
  const r = await D.resolve({ serviceName: 's' });
  assert.equal(r.selected.instanceId, 'hi'); // highest priority tier
  assert.equal(r.explanation.priority, 10);
  await assert.rejects(() => D.resolve({}), DiscoveryValidationError); // no serviceName
});

// ── version-aware discovery ────────────────────────────────────────────────────────

test('discovery: version-aware resolution honors a semver range', async () => {
  const clock = makeClock();
  const { D } = platform(clock);
  await D.register({
    serviceName: 's',
    instanceId: 'v1',
    endpoint: 'http://a:1',
    version: '1.0.0',
    healthStatus: 'healthy',
  });
  await D.register({
    serviceName: 's',
    instanceId: 'v2',
    endpoint: 'http://b:1',
    version: '2.3.0',
    healthStatus: 'healthy',
  });
  const r = await D.resolve({ serviceName: 's', version: '>=2.0.0' });
  assert.equal(r.selected.instanceId, 'v2');
  assert.equal((await D.discover({ serviceName: 's', version: '>=2.0.0' })).count, 1);
});

// ── cache behavior ─────────────────────────────────────────────────────────────────

test('discovery: discover hits the provider cache; register invalidates it', async () => {
  const clock = makeClock();
  const { D, dk } = platform(clock);
  await D.register({ serviceName: 's', endpoint: 'http://a:1', healthStatus: 'healthy' });
  await D.discover({ serviceName: 's' }); // miss (loads + caches)
  await D.discover({ serviceName: 's' }); // hit
  let m = dk.discovery.metrics();
  assert.equal(m.cacheHits, 1);
  await D.register({ serviceName: 's', endpoint: 'http://b:1', healthStatus: 'healthy' }); // invalidates
  await D.discover({ serviceName: 's' }); // miss again
  m = dk.discovery.metrics();
  assert.equal(m.cacheMisses, 2);
});

// ── integrity / verify ────────────────────────────────────────────────────────────

test('discovery: verify detects a tampered endpoint', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const { D } = platform(clock, { provider });
  const s = await D.register({ serviceName: 's', endpoint: 'http://a:1', healthStatus: 'healthy' });
  assert.equal((await D.verify({ namespace: 'default' })).ok, true);
  const stored = await provider.getService('default', s.serviceId);
  await provider.putService('default', { ...stored, endpoint: 'http://evil:1' }); // stale checksum
  const v = await D.verify({ namespace: 'default' });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.serviceId === s.serviceId));
});

// ── SDK adapter: namespace isolation + capability gates ──────────────────────────

test('sdk: owner-scoped port isolates namespaces + gates + no registration', async () => {
  const clock = makeClock();
  const { D } = platform(clock);
  await D.register(
    { serviceName: 's', endpoint: 'http://alice:1', healthStatus: 'healthy' },
    { namespace: 'ext.alice' }
  );
  await D.register(
    { serviceName: 's', endpoint: 'http://bob:1', healthStatus: 'healthy' },
    { namespace: 'ext.bob' }
  );
  const alice = toDiscoveryPort(D, { owner: 'alice' });
  const bob = toDiscoveryPort(D, { owner: 'bob' });
  assert.equal((await alice.resolve({ serviceName: 's' })).selected.endpoint, 'http://alice:1');
  assert.equal((await bob.resolve({ serviceName: 's' })).selected.endpoint, 'http://bob:1');
  assert.equal((await alice.list()).length, 1); // only own namespace
  assert.equal(typeof alice.register, 'undefined'); // no registration surface
  const noResolve = toDiscoveryPort(D, { owner: 'x', canResolve: false });
  await assert.rejects(async () => noResolve.resolve({ serviceName: 's' }), /discovery:resolve/);
  const noRead = toDiscoveryPort(D, { owner: 'y', canRead: false });
  await assert.rejects(async () => noRead.discover({}), /discovery:read/);
  assert.throws(() => toDiscoveryPort(D, {}), /owner required/);
});

// ── failure injection ──────────────────────────────────────────────────────────

test('discovery: provider failures are counted and surfaced', async () => {
  const clock = makeClock();
  const failing = {
    name: 'failing',
    putService: () => Promise.reject(new Error('registry down')),
    getService: () => Promise.resolve(null),
    listServices: () => Promise.resolve([]),
    removeService: () => Promise.resolve(false),
    health: () => ({ ok: false }),
  };
  const { D, dk } = platform(clock, { provider: failing });
  await assert.rejects(
    () => D.register({ serviceName: 's', endpoint: 'http://a:1' }),
    /registry down/
  );
  assert.ok(dk.discovery.metrics().providerFailures >= 1);
  assert.equal((await D.health()).ok, false);
});

// ── concurrency ─────────────────────────────────────────────────────────────────

test('discovery: concurrent registrations of distinct instances all persist', async () => {
  const clock = makeClock();
  const { D } = platform(clock);
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      D.register({
        serviceName: 's',
        instanceId: 'i' + i,
        endpoint: 'http://h' + i + ':1',
        healthStatus: 'healthy',
      })
    )
  );
  assert.equal((await D.discover({ serviceName: 's' })).count, 25);
});

// ── stress / performance ──────────────────────────────────────────────────────────

test('discovery: stress — 1000 instances resolve fast + consistent', async () => {
  const clock = makeClock();
  const { D } = platform(clock);
  for (let i = 0; i < 1000; i++) {
    await D.register({
      serviceName: 'svc' + (i % 50),
      instanceId: 'i' + i,
      endpoint: 'http://h' + i + ':1',
      healthStatus: 'healthy',
      weight: 1,
    });
  }
  const start = Date.now();
  let resolved = 0;
  for (let i = 0; i < 1000; i++) {
    const r = await D.resolve({ serviceName: 'svc' + (i % 50), key: 'k' + i });
    if (r.selected) resolved += 1;
  }
  const elapsed = Date.now() - start;
  assert.equal(resolved, 1000);
  assert.ok(elapsed < 3000, `expected < 3s, took ${elapsed}ms`);
  assert.equal((await D.verify({ namespace: 'default' })).ok, true);
  assert.equal(D.metrics().registeredServices, 50);
  assert.equal(D.metrics().registeredInstances, 1000);
});

test('service checksum is stable across re-hydration', async () => {
  const clock = makeClock();
  const { D, dk } = platform(clock);
  const s = await D.register({ serviceName: 's', endpoint: 'http://a:1', capabilities: ['x'] });
  const model = await dk.provider.getService('default', s.serviceId);
  assert.equal(model.checksum, computeChecksum(fromModel(model)));
});
