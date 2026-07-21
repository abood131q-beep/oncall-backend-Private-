'use strict';

/**
 * Enterprise Resource Management Kernel tests (Phase 15.10 / ADR-039) — covers every
 * required category: unit (resource + allocation value objects, checksum, capacity
 * math), allocation, quota, reservation, conflict resolution (priority preemption),
 * provider (+ future extension points), concurrency, stress, failure injection, and
 * performance, plus events-via-port and the SDK owner-scoped adapter (namespace
 * isolation + capability gates). Deterministic: clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createResource,
  fromModel,
  computeChecksum,
} = require('../../src/domain/resources/resource');
const { createAllocation } = require('../../src/domain/resources/allocation');
const { createResourcePlatform, providers } = require('../../src/application/resources');
const { createResourceMetrics } = require('../../src/application/resources/metrics');
const { toResourcePort } = require('../../src/application/resources/sdkAdapter');
const {
  ResourceValidationError,
  ResourceNotFoundError,
  QuotaExceededError,
  ResourceConflictError,
} = require('../../src/domain/resources/errors');

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
  const rk = createResourcePlatform({ clock, publisher: pub, ...extra });
  return { rk, R: rk.resources, pub };
}

// ── domain: resource value object + capacity math ──────────────────────────────────

test('resource: create, capacity math, checksum excludes allocated', () => {
  const clock = makeClock(1000);
  const r = createResource({ resourceType: 'cpu', capacity: 100, reservation: 20 }, { clock });
  assert.equal(r.allocatable(), 80); // capacity - reservation
  assert.equal(r.availableAmount(), 100);
  assert.equal(r.canAllocate(80), true);
  assert.equal(r.canAllocate(81), false);
  const before = r.checksum;
  r.applyAllocate(50, 1100); // allocated is NOT part of the checksum
  assert.equal(r.checksum, before);
  assert.equal(r.availableAmount(), 50);
  const re = fromModel(r.toModel(), { clock });
  assert.ok(re.verifyChecksum());
  assert.throws(() => createResource({ capacity: 1 }), ResourceValidationError); // no type
  assert.throws(() => createResource({ resourceType: 'x', capacity: 0 }), ResourceValidationError);
  assert.throws(
    () => createResource({ resourceType: 'x', capacity: 10, reservation: 20 }),
    ResourceValidationError
  );
});

test('allocation: value object + checksum', () => {
  const clock = makeClock();
  const a = createAllocation(
    { resourceId: 'r1', amount: 5, owner: 'trips', priority: 3 },
    { clock }
  );
  assert.equal(a.status, 'active');
  assert.ok(a.verifyChecksum());
  a.release(1100, false);
  assert.equal(a.status, 'released');
  assert.throws(() => createAllocation({ amount: 5 }), ResourceValidationError); // no resourceId
  assert.throws(() => createAllocation({ resourceId: 'r', amount: 0 }), ResourceValidationError);
});

// ── unit: metrics ─────────────────────────────────────────────────────────────────

test('metrics: gauges + counters + prometheus', () => {
  const m = createResourceMetrics({ clock: () => 0 });
  m.bindGauges({ resources: () => 2, active: () => 3, utilization: () => 0.5 });
  m.recordAllocation();
  m.recordQuotaViolation();
  const s = m.snapshot();
  assert.equal(s.registeredResources, 2);
  assert.equal(s.activeAllocations, 3);
  assert.equal(s.resourceUtilization, 0.5);
  assert.match(m.prometheus(), /resources_active_allocations 3/);
  assert.match(m.prometheus(), /resources_quota_violations_total 1/);
});

// ── provider + future extension points ───────────────────────────────────────────

test('provider: memory persists resources + allocations; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.putResource('n', { resourceId: 'r1', resourceType: 'cpu' });
  assert.equal((await mem.getResource('n', 'r1')).resourceType, 'cpu');
  await mem.putAllocation('n', { allocationId: 'a1', resourceId: 'r1', amount: 5 });
  assert.equal((await mem.getAllocation('n', 'a1')).amount, 5);
  assert.equal((await mem.listAllocations('n')).length, 1);
  assert.ok(providers.FUTURE_PROVIDERS.includes('postgresql'));
  const p = providers.futureProvider('redis');
  assert.equal(p.planned, true);
  assert.throws(() => p.putResource('n', {}), /extension point/);
});

// ── allocation + release + accounting + events ──────────────────────────────────────

test('resources: register + allocate + release adjusts accounting; events', async () => {
  const clock = makeClock(1000);
  const { R, pub } = platform(clock);
  const r = await R.registerResource({ resourceType: 'cpu', capacity: 100 });
  const a = await R.allocate({ resourceId: r.resourceId, amount: 30, owner: 'trips' });
  let q = await R.query({ resourceId: r.resourceId });
  assert.equal(q.allocated, 30);
  assert.equal(q.available, 70);
  assert.equal(q.activeAllocations, 1);
  assert.equal(await R.release({ allocationId: a.allocationId }), true);
  q = await R.query({ resourceId: r.resourceId });
  assert.equal(q.allocated, 0);
  assert.equal(q.available, 100);
  assert.equal(await R.release({ allocationId: a.allocationId }), false); // already released
  const types = pub.events.map((e) => e.type);
  assert.ok(
    types.includes('ResourceRegistered') &&
      types.includes('ResourceAllocated') &&
      types.includes('ResourceReleased')
  );
  assert.ok(pub.events.every((e) => e.producer === 'resources'));
  await assert.rejects(
    () => R.allocate({ resourceId: r.resourceId, amount: 0 }),
    ResourceValidationError
  );
  await assert.rejects(() => R.allocate({ resourceId: 'ghost', amount: 1 }), ResourceNotFoundError);
});

// ── quota ──────────────────────────────────────────────────────────────────────────

test('resources: per-owner quota is enforced', async () => {
  const clock = makeClock();
  const { R, rk, pub } = platform(clock);
  const r = await R.registerResource({ resourceType: 'cpu', capacity: 100, quota: 30 });
  await R.allocate({ resourceId: r.resourceId, amount: 20, owner: 'trips' });
  await R.allocate({ resourceId: r.resourceId, amount: 10, owner: 'trips' }); // at quota
  await assert.rejects(
    () => R.allocate({ resourceId: r.resourceId, amount: 5, owner: 'trips' }),
    QuotaExceededError
  );
  // a different owner is unaffected by trips' quota
  await R.allocate({ resourceId: r.resourceId, amount: 30, owner: 'billing' });
  assert.ok(rk.resources.metrics().quotaViolations >= 1);
  assert.ok(pub.events.some((e) => e.type === 'QuotaExceeded'));
});

// ── reservation ─────────────────────────────────────────────────────────────────

test('resources: reservation keeps headroom unallocatable', async () => {
  const clock = makeClock();
  const { R } = platform(clock);
  const r = await R.registerResource({ resourceType: 'cpu', capacity: 100, reservation: 40 });
  await R.allocate({ resourceId: r.resourceId, amount: 60, owner: 'a' }); // fills allocatable (100-40)
  await assert.rejects(
    () => R.allocate({ resourceId: r.resourceId, amount: 1, owner: 'b', priority: 0 }),
    ResourceConflictError
  );
  const q = await R.query({ resourceId: r.resourceId });
  assert.equal(q.allocatable, 60);
  assert.equal(q.allocated, 60);
});

// ── conflict resolution (priority preemption) ───────────────────────────────────────

test('resources: higher-priority allocation preempts lower-priority ones', async () => {
  const clock = makeClock();
  const { R, rk, pub } = platform(clock);
  const r = await R.registerResource({ resourceType: 'cpu', capacity: 100 });
  const lo1 = await R.allocate({ resourceId: r.resourceId, amount: 60, owner: 'lo', priority: 1 });
  const lo2 = await R.allocate({ resourceId: r.resourceId, amount: 40, owner: 'lo', priority: 2 });
  // full now; a priority-5 request for 50 preempts the lowest-priority allocation(s)
  const hi = await R.allocate({ resourceId: r.resourceId, amount: 50, owner: 'hi', priority: 5 });
  assert.ok(hi.allocationId);
  // lo1 (priority 1) was preempted to make room
  assert.equal((await rk.provider.getAllocation('default', lo1.allocationId)).status, 'preempted');
  assert.equal((await rk.provider.getAllocation('default', lo2.allocationId)).status, 'active');
  assert.ok(rk.resources.metrics().preemptions >= 1);
  assert.ok(pub.events.some((e) => e.type === 'ResourceReleased' && e.payload.preempted === true));
  // a low-priority request that cannot preempt anyone is rejected
  await assert.rejects(
    () => R.allocate({ resourceId: r.resourceId, amount: 100, owner: 'x', priority: 0 }),
    ResourceConflictError
  );
});

// ── integrity / verify ────────────────────────────────────────────────────────────

test('resources: verify detects tampering + accounting drift', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const { R } = platform(clock, { provider });
  const r = await R.registerResource({ resourceType: 'cpu', capacity: 100 });
  await R.allocate({ resourceId: r.resourceId, amount: 30, owner: 'a' });
  assert.equal((await R.verify({ namespace: 'default' })).ok, true);
  // tamper: change allocated without a matching allocation → accounting drift
  const stored = await provider.getResource('default', r.resourceId);
  await provider.putResource('default', { ...stored, allocated: 99 });
  const v = await R.verify({ namespace: 'default' });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.reason === 'accounting drift'));
});

// ── SDK adapter ─────────────────────────────────────────────────────────────────────

test('sdk: owner-scoped port isolates namespaces + gates + no authoring', async () => {
  const clock = makeClock();
  const { R } = platform(clock);
  const r = await R.registerResource(
    { resourceType: 'cpu', capacity: 100 },
    { namespace: 'ext.alice' }
  );
  const alice = toResourcePort(R, { owner: 'alice' });
  const a = await alice.allocate({ resourceId: r.resourceId, amount: 10 });
  assert.equal(a.owner, 'alice'); // stamped with the extension owner
  assert.equal((await alice.list()).length, 1); // only own namespace
  assert.equal(typeof alice.registerResource, 'undefined'); // no authoring
  const noAlloc = toResourcePort(R, { owner: 'x', canAllocate: false });
  await assert.rejects(
    async () => noAlloc.allocate({ resourceId: 'r', amount: 1 }),
    /resource:allocate/
  );
  const noRead = toResourcePort(R, { owner: 'y', canRead: false });
  await assert.rejects(async () => noRead.query({ resourceId: 'r' }), /resource:read/);
  assert.throws(() => toResourcePort(R, {}), /owner required/);
});

// ── failure injection ──────────────────────────────────────────────────────────

test('resources: provider failures are counted and surfaced', async () => {
  const clock = makeClock();
  const failing = {
    name: 'failing',
    putResource: () => Promise.reject(new Error('db down')),
    getResource: () => Promise.resolve(null),
    listResources: () => Promise.resolve([]),
    removeResource: () => Promise.resolve(false),
    putAllocation: () => Promise.resolve(),
    getAllocation: () => Promise.resolve(null),
    listAllocations: () => Promise.resolve([]),
    health: () => ({ ok: false }),
  };
  const { R, rk } = platform(clock, { provider: failing });
  await assert.rejects(() => R.registerResource({ resourceType: 'cpu', capacity: 1 }), /db down/);
  assert.ok(rk.resources.metrics().providerFailures >= 1);
  assert.equal((await R.health()).ok, false);
});

// ── concurrency ─────────────────────────────────────────────────────────────────

test('resources: concurrent allocations never over-commit capacity', async () => {
  const clock = makeClock();
  const { R } = platform(clock);
  const r = await R.registerResource({ resourceType: 'slots', capacity: 10 });
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      R.allocate({ resourceId: r.resourceId, amount: 1, owner: 'o' + i })
    )
  );
  const granted = results.filter((x) => x.status === 'fulfilled').length;
  assert.equal(granted, 10); // exactly capacity; mutex prevents over-commit
  const q = await R.query({ resourceId: r.resourceId });
  assert.equal(q.allocated, 10);
  assert.equal(q.available, 0);
});

// ── stress / performance ──────────────────────────────────────────────────────────

test('resources: stress — 1000 allocate/release cycles consistent + fast', async () => {
  const clock = makeClock();
  const { R } = platform(clock);
  const r = await R.registerResource({ resourceType: 'cpu', capacity: 1000000 });
  const start = Date.now();
  for (let i = 0; i < 1000; i++) {
    const a = await R.allocate({ resourceId: r.resourceId, amount: 5, owner: 'o' + (i % 10) });
    await R.release({ allocationId: a.allocationId });
  }
  const elapsed = Date.now() - start;
  const q = await R.query({ resourceId: r.resourceId });
  assert.equal(q.allocated, 0); // all released
  assert.ok(elapsed < 3000, `expected < 3s, took ${elapsed}ms`);
  assert.equal((await R.verify({ namespace: 'default' })).ok, true);
});

test('resource checksum is stable across re-hydration', async () => {
  const clock = makeClock();
  const { R, rk } = platform(clock);
  const r = await R.registerResource({ resourceType: 'cpu', capacity: 100, quota: 40 });
  const model = await rk.provider.getResource('default', r.resourceId);
  assert.equal(model.checksum, computeChecksum(fromModel(model)));
});
