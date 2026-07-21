'use strict';

/**
 * Enterprise Multi-Tenancy Kernel tests (Phase 15.9 / ADR-038) — covers every
 * required category: unit (tenant value object, context inheritance, capability),
 * tenant resolution, isolation, lifecycle, capability, provider (+ future extension
 * points), concurrency, stress, failure injection, and performance, plus
 * events-via-port and the SDK owner-scoped adapter (namespace isolation +
 * cross-tenant prevention + capability gates). Deterministic: clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTenant,
  fromModel,
  computeChecksum,
  STATUS,
} = require('../../src/domain/tenancy/tenant');
const { buildContext, inherit, hasCapability } = require('../../src/domain/tenancy/context');
const { createTenancyPlatform, providers } = require('../../src/application/tenancy');
const { createTenancyMetrics } = require('../../src/application/tenancy/metrics');
const { createContextCache } = require('../../src/application/tenancy/cache');
const { toTenancyPort } = require('../../src/application/tenancy/sdkAdapter');
const {
  TenancyValidationError,
  TenantNotFoundError,
  CrossTenantError,
} = require('../../src/domain/tenancy/errors');

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
  const tk = createTenancyPlatform({ clock, publisher: pub, ...extra });
  return { tk, T: tk.tenancy, pub };
}

// ── domain: tenant value object + checksum ────────────────────────────────────────

test('tenant: create, validation, checksum, lifecycle bumps checksum', () => {
  const clock = makeClock(1000);
  const t = createTenant({ tenantName: 'acme', capabilities: ['premium'] }, { clock });
  assert.equal(t.tenantStatus, STATUS.PENDING);
  assert.ok(t.verifyChecksum());
  const before = t.checksum;
  t.activate(1100); // status IS part of the checksum → changes
  assert.equal(t.tenantStatus, STATUS.ACTIVE);
  assert.notEqual(t.checksum, before);
  const re = fromModel(t.toModel(), { clock });
  assert.ok(re.verifyChecksum());
  assert.throws(() => createTenant({}), TenancyValidationError); // no name
  assert.throws(
    () => createTenant({ tenantName: 'x', isolationLevel: 'nope' }),
    TenancyValidationError
  );
});

// ── domain: context inheritance + capability ────────────────────────────────────────

test('context: inheritance merges platform defaults under tenant values', () => {
  const clock = makeClock();
  const t = createTenant(
    {
      tenantName: 'acme',
      capabilities: ['premium'],
      labels: { tier: 'gold' },
      configRef: 'cfg-acme',
    },
    { clock }
  );
  const merged = inherit(
    { capabilities: ['base'], labels: { region: 'us' }, configRef: 'cfg-default' },
    t
  );
  assert.deepEqual(merged.capabilities, ['base', 'premium']); // union, sorted
  assert.deepEqual(merged.labels, { region: 'us', tier: 'gold' });
  assert.equal(merged.configRef, 'cfg-acme'); // tenant overrides default
  const ctx = buildContext(t, { defaults: { capabilities: ['base'] }, now: 1000 });
  assert.ok(Object.isFrozen(ctx));
  assert.ok(hasCapability(ctx, 'base') && hasCapability(ctx, 'premium'));
  assert.equal(hasCapability(ctx, 'nope'), false);
});

// ── unit: metrics + cache ─────────────────────────────────────────────────────────

test('metrics: gauges + counters + prometheus', () => {
  const m = createTenancyMetrics({ clock: () => 0 });
  m.bindGauges({ registered: () => 5, active: () => 3 });
  m.recordResolution();
  m.recordActivation();
  const s = m.snapshot();
  assert.equal(s.registeredTenants, 5);
  assert.equal(s.activeTenants, 3);
  assert.equal(s.resolutions, 1);
  assert.match(m.prometheus(), /tenancy_active_tenants 3/);
  assert.match(m.prometheus(), /tenancy_resolutions_total 1/);
});

test('cache: checksum-keyed hit/miss + invalidation', () => {
  const c = createContextCache({ maxSize: 2 });
  assert.equal(c.get('ns:t1:c1'), undefined);
  c.set('ns:t1:c1', { x: 1 });
  assert.deepEqual(c.get('ns:t1:c1'), { x: 1 });
  c.invalidate('ns', 't1');
  assert.equal(c.get('ns:t1:c1'), undefined);
});

// ── provider + future extension points ───────────────────────────────────────────

test('provider: memory stores tenants by id + name; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.putTenant('n', { tenantId: 't1', tenantName: 'acme' });
  assert.equal((await mem.getTenant('n', 't1')).tenantName, 'acme');
  assert.equal((await mem.getTenantByName('n', 'acme')).tenantId, 't1');
  assert.equal((await mem.listTenants('n')).length, 1);
  assert.equal(await mem.removeTenant('n', 't1'), true);
  assert.ok(providers.FUTURE_PROVIDERS.includes('postgresql'));
  const p = providers.futureProvider('mongodb');
  assert.equal(p.planned, true);
  assert.throws(() => p.putTenant('n', {}), /extension point/);
});

// ── register + resolve + lifecycle + events ─────────────────────────────────────────

test('tenancy: register + activate + resolve context; events', async () => {
  const clock = makeClock(1000);
  const { T, pub } = platform(clock, { defaults: { capabilities: ['base'] } });
  const t = await T.registerTenant({ tenantName: 'acme', capabilities: ['premium'] });
  assert.equal(t.tenantStatus, STATUS.PENDING);
  let ctx = await T.resolveTenant({ tenantId: t.tenantId });
  assert.equal(ctx.active, false);
  assert.ok(ctx.capabilities.includes('base') && ctx.capabilities.includes('premium'));
  await T.activateTenant({ tenantId: t.tenantId });
  ctx = await T.resolveTenant({ tenantId: t.tenantId });
  assert.equal(ctx.active, true);
  await T.deactivateTenant({ tenantId: t.tenantId });
  assert.equal((await T.resolveTenant({ tenantName: 'acme' })).active, false);
  const types = pub.events.map((e) => e.type);
  assert.ok(
    types.includes('TenantRegistered') &&
      types.includes('TenantActivated') &&
      types.includes('TenantDeactivated') &&
      types.includes('TenantResolved')
  );
  assert.ok(pub.events.every((e) => e.producer === 'tenancy'));
  await assert.rejects(() => T.registerTenant({ tenantName: 'acme' }), TenancyValidationError); // dup name
  await assert.rejects(() => T.resolveTenant({ tenantId: 'ghost' }), TenantNotFoundError);
  await assert.rejects(() => T.resolveTenant({}), TenancyValidationError);
});

// ── isolation (namespace) ─────────────────────────────────────────────────────────

test('tenancy: tenants are isolated per namespace', async () => {
  const clock = makeClock();
  const { T } = platform(clock);
  await T.registerTenant({ tenantName: 'acme' }, { namespace: 'region-a' });
  await T.registerTenant({ tenantName: 'acme' }, { namespace: 'region-b' }); // same name, different ns OK
  assert.equal((await T.list({ namespace: 'region-a' })).length, 1);
  assert.equal((await T.list({ namespace: 'region-b' })).length, 1);
  // a tenant in region-a is not resolvable from region-b
  const a = (await T.list({ namespace: 'region-a' }))[0];
  await assert.rejects(
    () => T.resolveTenant({ tenantId: a.tenantId }, { namespace: 'region-b' }),
    TenantNotFoundError
  );
});

// ── context caching ─────────────────────────────────────────────────────────────

test('tenancy: resolve caches context; lifecycle change invalidates it', async () => {
  const clock = makeClock();
  const { T, tk } = platform(clock);
  const t = await T.registerTenant({ tenantName: 'acme' });
  await T.resolveTenant({ tenantId: t.tenantId }); // miss
  await T.resolveTenant({ tenantId: t.tenantId }); // hit
  let m = tk.tenancy.metrics();
  assert.equal(m.cacheHits, 1);
  await T.activateTenant({ tenantId: t.tenantId }); // invalidates + checksum changes
  await T.resolveTenant({ tenantId: t.tenantId }); // miss again
  m = tk.tenancy.metrics();
  assert.equal(m.cacheMisses, 2);
});

// ── capability ─────────────────────────────────────────────────────────────────────

test('tenancy: capabilities inherited from defaults + tenant in the context', async () => {
  const clock = makeClock();
  const { T } = platform(clock, { defaults: { capabilities: ['read'], labels: { plan: 'std' } } });
  const t = await T.registerTenant({
    tenantName: 'acme',
    capabilities: ['write'],
    labels: { plan: 'gold' },
  });
  const ctx = await T.resolveTenant({ tenantId: t.tenantId });
  assert.deepEqual(ctx.capabilities, ['read', 'write']);
  assert.equal(ctx.labels.plan, 'gold'); // tenant overrides default label
});

// ── integrity / verify ────────────────────────────────────────────────────────────

test('tenancy: verify + resolve detect a tampered tenant', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const { T } = platform(clock, { provider });
  const t = await T.registerTenant({ tenantName: 'acme' });
  assert.equal((await T.verify({ namespace: 'default' })).ok, true);
  const stored = await provider.getTenant('default', t.tenantId);
  await provider.putTenant('default', { ...stored, isolationLevel: 'shared' }); // stale checksum
  const v = await T.verify({ namespace: 'default' });
  assert.equal(v.ok, false);
  await assert.rejects(() => T.resolveTenant({ tenantId: t.tenantId }), /integrity/);
});

// ── SDK adapter: namespace isolation + cross-tenant prevention + gates ─────────────

test('sdk: owner-scoped port isolates namespaces, prevents cross-tenant + gates', async () => {
  const clock = makeClock();
  const { T } = platform(clock);
  const t = await T.registerTenant({ tenantName: 'acme' }, { namespace: 'ext.alice' });
  const alice = toTenancyPort(T, { owner: 'alice', tenantId: t.tenantId, canManage: true });
  // scoped resolve (implicit own tenant)
  const ctx = await alice.resolveTenant({});
  assert.equal(ctx.tenantId, t.tenantId);
  // cross-tenant access blocked
  await assert.rejects(async () => alice.resolveTenant({ tenantId: 'other' }), CrossTenantError);
  // capability gates
  const readOnly = toTenancyPort(T, { owner: 'ro', canManage: false });
  await assert.rejects(async () => readOnly.registerTenant({ tenantName: 'x' }), /tenant:manage/);
  const noRead = toTenancyPort(T, { owner: 'nr', canRead: false });
  await assert.rejects(async () => noRead.list(), /tenant:read/);
  assert.throws(() => toTenancyPort(T, {}), /owner required/);
});

// ── failure injection ──────────────────────────────────────────────────────────

test('tenancy: provider failures are counted and surfaced', async () => {
  const clock = makeClock();
  const failing = {
    name: 'failing',
    putTenant: () => Promise.reject(new Error('db down')),
    getTenant: () => Promise.resolve(null),
    getTenantByName: () => Promise.resolve(null),
    listTenants: () => Promise.resolve([]),
    removeTenant: () => Promise.resolve(false),
    health: () => ({ ok: false }),
  };
  const { T, tk } = platform(clock, { provider: failing });
  await assert.rejects(() => T.registerTenant({ tenantName: 'x' }), /db down/);
  assert.ok(tk.tenancy.metrics().providerFailures >= 1);
  assert.equal((await T.health()).ok, false);
});

// ── concurrency ─────────────────────────────────────────────────────────────────

test('tenancy: concurrent registrations of distinct tenants all persist', async () => {
  const clock = makeClock();
  const { T } = platform(clock);
  await Promise.all(
    Array.from({ length: 25 }, (_, i) => T.registerTenant({ tenantName: 'tenant-' + i }))
  );
  assert.equal((await T.list()).length, 25);
});

// ── stress / performance ──────────────────────────────────────────────────────────

test('tenancy: stress — 1000 tenants resolve fast + consistent', async () => {
  const clock = makeClock();
  const { T, tk } = platform(clock);
  const ids = [];
  for (let i = 0; i < 1000; i++)
    ids.push((await T.registerTenant({ tenantName: 't' + i })).tenantId);
  const start = Date.now();
  let ok = 0;
  for (const id of ids) {
    const ctx = await T.resolveTenant({ tenantId: id });
    if (ctx.tenantId === id) ok += 1;
  }
  const elapsed = Date.now() - start;
  assert.equal(ok, 1000);
  assert.ok(elapsed < 3000, `expected < 3s, took ${elapsed}ms`);
  assert.equal(tk.tenancy.metrics().registeredTenants, 1000);
  assert.equal((await T.verify({ namespace: 'default' })).ok, true);
});

test('tenant checksum is stable across re-hydration', async () => {
  const clock = makeClock();
  const { T, tk } = platform(clock);
  const t = await T.registerTenant({ tenantName: 'acme', capabilities: ['x'] });
  const model = await tk.provider.getTenant('default', t.tenantId);
  assert.equal(model.checksum, computeChecksum(fromModel(model)));
});
