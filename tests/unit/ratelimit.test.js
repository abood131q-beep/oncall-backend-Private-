'use strict';

/**
 * Enterprise Rate Limiting Kernel tests (Phase 15.2 / ADR-031) — covers every
 * required category: unit (policy value object, checksum), algorithm (fixed/sliding
 * window, token/leaky bucket), quota, burst, provider (+ future extension points),
 * concurrency, stress, failure injection, and performance, plus events-via-port and
 * the SDK owner-scoped adapter (namespace isolation + capability gates).
 * Deterministic: clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPolicy,
  fromModel,
  computeChecksum,
  ALGORITHMS,
} = require('../../src/domain/ratelimit/policy');
const algorithms = require('../../src/domain/ratelimit/algorithms');
const { createRateLimitPlatform, providers } = require('../../src/application/ratelimit');
const { createRateLimitMetrics } = require('../../src/application/ratelimit/metrics');
const { createUsageCache } = require('../../src/application/ratelimit/cache');
const { toRateLimitPort } = require('../../src/application/ratelimit/sdkAdapter');
const {
  RateLimitValidationError,
  PolicyNotFoundError,
  IntegrityError,
} = require('../../src/domain/ratelimit/errors');

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

// ── domain: policy value object + checksum ───────────────────────────────────────

test('policy: create, validation, checksum round-trip', () => {
  const clock = makeClock();
  const p = createPolicy(
    { name: 'api', limit: 100, window: 60000, algorithm: 'token_bucket', burstLimit: 120 },
    { clock }
  );
  assert.equal(p.algorithm, ALGORITHMS.TOKEN_BUCKET);
  assert.equal(p.capacity(), 120);
  assert.ok(p.checksum && p.checksum.length === 64);
  assert.ok(p.verifyChecksum());
  const re = fromModel(p.toModel(), { clock });
  assert.equal(re.checksum, p.checksum);
  assert.ok(re.verifyChecksum());
  assert.throws(() => createPolicy({ limit: 1, window: 1 }), RateLimitValidationError); // no name
  assert.throws(() => createPolicy({ name: 'x', limit: 0, window: 1 }), RateLimitValidationError);
  assert.throws(
    () => createPolicy({ name: 'x', limit: 1, window: 1, algorithm: 'nope' }),
    RateLimitValidationError
  );
  assert.throws(
    () => createPolicy({ name: 'x', limit: 10, window: 1, burstLimit: 5 }),
    RateLimitValidationError
  );
});

// ── domain: algorithms (all four, pure + deterministic) ──────────────────────────

test('algorithm: fixed window admits up to limit then blocks, resets next window', () => {
  const p = createPolicy(
    { name: 'f', limit: 3, window: 1000, algorithm: 'fixed_window' },
    { clock: makeClock() }
  );
  let state = null;
  const results = [];
  for (let i = 0; i < 4; i++) {
    const r = algorithms.evaluate(p, state, 1000, 1);
    results.push(r.allowed);
    if (r.allowed) state = r.stateIfConsumed;
    else state = r.stateDecayed;
  }
  assert.deepEqual(results, [true, true, true, false]);
  // next window resets
  const r = algorithms.evaluate(p, state, 2000, 1);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 2);
});

test('algorithm: sliding window evicts old entries deterministically', () => {
  const p = createPolicy(
    { name: 's', limit: 2, window: 1000, algorithm: 'sliding_window' },
    { clock: makeClock() }
  );
  let state = algorithms.evaluate(p, null, 1000, 1).stateIfConsumed; // t=1000
  state = algorithms.evaluate(p, state, 1500, 1).stateIfConsumed; // t=1500 → usage 2
  assert.equal(algorithms.evaluate(p, state, 1600, 1).allowed, false); // full
  // at t=2100 the first (t=1000) has aged out of the 1000ms window
  const r = algorithms.evaluate(p, state, 2100, 1);
  assert.equal(r.allowed, true);
});

test('algorithm: token bucket refills over time; burst capacity', () => {
  const p = createPolicy(
    { name: 't', limit: 10, window: 1000, algorithm: 'token_bucket', burstLimit: 10 },
    { clock: makeClock() }
  );
  // drain 10 tokens instantly
  let state = null;
  for (let i = 0; i < 10; i++) state = algorithms.evaluate(p, state, 1000, 1).stateIfConsumed;
  assert.equal(algorithms.evaluate(p, state, 1000, 1).allowed, false); // empty
  // after 500ms → ~5 tokens refilled (rate 10/1000ms)
  const r = algorithms.evaluate(p, state, 1500, 1);
  assert.equal(r.allowed, true);
  assert.ok(r.remaining >= 3 && r.remaining <= 5);
});

test('algorithm: leaky bucket drains over time', () => {
  const p = createPolicy(
    { name: 'l', limit: 5, window: 1000, algorithm: 'leaky_bucket' },
    { clock: makeClock() }
  );
  let state = null;
  for (let i = 0; i < 5; i++) state = algorithms.evaluate(p, state, 1000, 1).stateIfConsumed;
  assert.equal(algorithms.evaluate(p, state, 1000, 1).allowed, false); // full
  const r = algorithms.evaluate(p, state, 1600, 1); // ~3 leaked
  assert.equal(r.allowed, true);
});

// ── unit: metrics + cache ─────────────────────────────────────────────────────────

test('metrics: counters + policies gauge + prometheus', () => {
  const m = createRateLimitMetrics({ clock: () => 0 });
  m.bindGauges({ registeredPolicies: () => 2 });
  m.recordEvaluation();
  m.recordAllowed();
  m.recordBlocked();
  m.recordConsumption(3);
  const s = m.snapshot();
  assert.equal(s.registeredPolicies, 2);
  assert.equal(s.allowed, 1);
  assert.equal(s.blocked, 1);
  assert.equal(s.consumption, 3);
  assert.match(m.prometheus(), /ratelimit_allowed_total 1/);
  assert.match(m.prometheus(), /ratelimit_registered_policies 2/);
});

test('cache: write-through + FIFO bound + hit/miss', () => {
  const c = createUsageCache({ maxSize: 2 });
  assert.equal(c.get('a'), undefined); // miss
  c.set('a', { n: 1 });
  assert.deepEqual(c.get('a'), { n: 1 }); // hit
  c.set('b', { n: 2 });
  c.set('c', { n: 3 }); // evicts a
  assert.equal(c.get('a'), undefined);
  assert.equal(c.stats().size, 2);
});

// ── provider + future extension points ───────────────────────────────────────────

test('provider: memory persists policies + counters; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.putPolicy('n', { policyId: 'p1', name: 'x' });
  assert.equal((await mem.getPolicy('n', 'p1')).name, 'x');
  assert.equal((await mem.listPolicies('n')).length, 1);
  await mem.putCounter('n', 'k1', { count: 3 });
  assert.equal((await mem.getCounter('n', 'k1')).count, 3);
  assert.equal(await mem.resetCounter('n', 'k1'), true);
  assert.ok(providers.FUTURE_PROVIDERS.includes('redis'));
  const p = providers.futureProvider('postgresql');
  assert.equal(p.planned, true);
  assert.throws(() => p.putPolicy('n', {}), /extension point/);
});

// ── service: register + evaluate + consume + events ───────────────────────────────

test('ratelimit: register + evaluate (dry run) + consume (mutates); events', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const rl = createRateLimitPlatform({ clock, publisher: pub });
  const R = rl.ratelimit;
  const p = await R.registerPolicy({
    name: 'api',
    limit: 2,
    window: 1000,
    algorithm: 'fixed_window',
  });
  // evaluate does NOT consume
  assert.equal((await R.evaluate({ policyId: p.policyId, subject: 'u1' })).allowed, true);
  // remaining reflects capacity left AFTER the evaluated request; dry-run does not
  // mutate, so the counter is unchanged and both evaluates return the same value.
  assert.equal((await R.evaluate({ policyId: p.policyId, subject: 'u1' })).remaining, 1);
  // consume twice → allowed, third → blocked
  assert.equal((await R.consume({ policyId: p.policyId, subject: 'u1' })).allowed, true);
  assert.equal((await R.consume({ policyId: p.policyId, subject: 'u1' })).allowed, true);
  const blocked = await R.consume({ policyId: p.policyId, subject: 'u1' });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  const types = pub.events.map((e) => e.type);
  assert.ok(
    types.includes('RatePolicyRegistered') &&
      types.includes('RateLimitEvaluated') &&
      types.includes('QuotaConsumed') &&
      types.includes('QuotaExceeded')
  );
  assert.ok(pub.events.every((e) => e.producer === 'ratelimit'));
  await assert.rejects(() => R.consume({ subject: '' }), RateLimitValidationError);
  await assert.rejects(() => R.consume({ policyId: 'ghost', subject: 'u1' }), PolicyNotFoundError);
});

// ── quota + isolation between subjects ─────────────────────────────────────────────

test('ratelimit: quota is tracked per subject independently', async () => {
  const clock = makeClock();
  const rl = createRateLimitPlatform({ clock });
  const R = rl.ratelimit;
  const p = await R.registerPolicy({
    name: 'api',
    limit: 1,
    window: 1000,
    algorithm: 'fixed_window',
  });
  assert.equal((await R.consume({ policyId: p.policyId, subject: 'a' })).allowed, true);
  assert.equal((await R.consume({ policyId: p.policyId, subject: 'a' })).allowed, false); // a exhausted
  assert.equal((await R.consume({ policyId: p.policyId, subject: 'b' })).allowed, true); // b independent
});

// ── burst ─────────────────────────────────────────────────────────────────────────

test('ratelimit: burst limit allows a spike above the sustained limit', async () => {
  const clock = makeClock(1000);
  const rl = createRateLimitPlatform({ clock });
  const R = rl.ratelimit;
  const p = await R.registerPolicy({
    name: 'b',
    limit: 2,
    window: 1000,
    algorithm: 'token_bucket',
    burstLimit: 5,
  });
  let allowed = 0;
  for (let i = 0; i < 6; i++)
    if ((await R.consume({ policyId: p.policyId, subject: 'u' })).allowed) allowed += 1;
  assert.equal(allowed, 5); // burst capacity, not just the sustained limit of 2
});

// ── reset ───────────────────────────────────────────────────────────────────────

test('ratelimit: reset clears a subject quota', async () => {
  const clock = makeClock();
  const pub = recordingPublisher();
  const rl = createRateLimitPlatform({ clock, publisher: pub });
  const R = rl.ratelimit;
  const p = await R.registerPolicy({
    name: 'api',
    limit: 1,
    window: 100000,
    algorithm: 'fixed_window',
  });
  await R.consume({ policyId: p.policyId, subject: 'u1' });
  assert.equal((await R.consume({ policyId: p.policyId, subject: 'u1' })).allowed, false);
  assert.equal(await R.reset({ policyId: p.policyId, subject: 'u1' }), true);
  assert.equal((await R.consume({ policyId: p.policyId, subject: 'u1' })).allowed, true); // fresh quota
  assert.ok(pub.events.some((e) => e.type === 'QuotaReset'));
});

// ── priority resolution ────────────────────────────────────────────────────────

test('ratelimit: highest-priority policy governs when selecting by subjectType', async () => {
  const clock = makeClock();
  const rl = createRateLimitPlatform({ clock });
  const R = rl.ratelimit;
  await R.registerPolicy({
    name: 'loose',
    subjectType: 'ip',
    limit: 100,
    window: 1000,
    priority: 1,
  });
  await R.registerPolicy({
    name: 'strict',
    subjectType: 'ip',
    limit: 1,
    window: 1000,
    priority: 10,
  });
  // no policyId → resolves by subjectType, highest priority (strict, limit 1)
  assert.equal((await R.consume({ subjectType: 'ip', subject: '1.2.3.4' })).allowed, true);
  assert.equal((await R.consume({ subjectType: 'ip', subject: '1.2.3.4' })).allowed, false);
});

// ── integrity / verify ────────────────────────────────────────────────────────────

test('ratelimit: verify + evaluate detect a tampered policy', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const rl = createRateLimitPlatform({ clock, provider });
  const R = rl.ratelimit;
  const p = await R.registerPolicy({ name: 'api', limit: 5, window: 1000 });
  assert.equal((await R.verify({ namespace: 'default' })).ok, true);
  // tamper: raise the limit but keep the stale checksum
  const stored = await provider.getPolicy('default', p.policyId);
  await provider.putPolicy('default', { ...stored, limit: 999999 });
  const v = await R.verify({ namespace: 'default' });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.policyId === p.policyId));
  await assert.rejects(() => R.consume({ policyId: p.policyId, subject: 'u1' }), IntegrityError);
});

// ── SDK adapter: namespace isolation + capability gates ──────────────────────────

test('sdk: owner-scoped port isolates namespaces + gates + no authoring', async () => {
  const clock = makeClock();
  const rl = createRateLimitPlatform({ clock });
  const R = rl.ratelimit;
  const pa = await R.registerPolicy(
    { name: 'api', limit: 1, window: 1000 },
    { namespace: 'ext.alice' }
  );
  await R.registerPolicy({ name: 'api', limit: 5, window: 1000 }, { namespace: 'ext.bob' });
  const alice = toRateLimitPort(R, { owner: 'alice' });
  assert.equal((await alice.consume({ policyId: pa.policyId, subject: 'x' })).allowed, true);
  assert.equal((await alice.consume({ policyId: pa.policyId, subject: 'x' })).allowed, false); // alice limit 1
  assert.equal((await alice.list()).length, 1); // only alice's namespace
  assert.equal(typeof alice.registerPolicy, 'undefined'); // no authoring
  assert.equal(typeof alice.reset, 'undefined'); // no reset
  const noEval = toRateLimitPort(R, { owner: 'x', canEvaluate: false });
  await assert.rejects(async () => noEval.consume({ subject: 'u' }), /rate:evaluate/);
  const noRead = toRateLimitPort(R, { owner: 'y', canRead: false });
  await assert.rejects(async () => noRead.list(), /rate:read/);
  assert.throws(() => toRateLimitPort(R, {}), /owner required/);
});

// ── failure injection ──────────────────────────────────────────────────────────

test('ratelimit: provider failures are counted and surfaced', async () => {
  const clock = makeClock();
  const failing = {
    name: 'failing',
    putPolicy: () => Promise.reject(new Error('db down')),
    getPolicy: () => Promise.resolve(null),
    listPolicies: () => Promise.resolve([]),
    removePolicy: () => Promise.resolve(false),
    getCounter: () => Promise.resolve(null),
    putCounter: () => Promise.resolve(),
    resetCounter: () => Promise.resolve(false),
    health: () => ({ ok: false }),
  };
  const rl = createRateLimitPlatform({ clock, provider: failing });
  await assert.rejects(
    () => rl.ratelimit.registerPolicy({ name: 'x', limit: 1, window: 1 }),
    /db down/
  );
  assert.ok(rl.ratelimit.metrics().providerFailures >= 1);
  assert.equal((await rl.ratelimit.health()).ok, false);
});

// ── concurrency ─────────────────────────────────────────────────────────────────

test('ratelimit: concurrent consumes on one subject never exceed the limit', async () => {
  const clock = makeClock(1000);
  const rl = createRateLimitPlatform({ clock });
  const R = rl.ratelimit;
  const p = await R.registerPolicy({
    name: 'api',
    limit: 5,
    window: 100000,
    algorithm: 'fixed_window',
  });
  const results = await Promise.all(
    Array.from({ length: 20 }, () => R.consume({ policyId: p.policyId, subject: 'u1' }))
  );
  const allowed = results.filter((r) => r.allowed).length;
  assert.equal(allowed, 5); // serialization mutex prevents over-admission
});

// ── stress / performance ──────────────────────────────────────────────────────────

test('ratelimit: stress — 2000 consumes across subjects are consistent + fast', async () => {
  const clock = makeClock(1000);
  const rl = createRateLimitPlatform({ clock });
  const R = rl.ratelimit;
  const p = await R.registerPolicy({
    name: 'api',
    limit: 10,
    window: 100000,
    algorithm: 'token_bucket',
  });
  const start = Date.now();
  let allowed = 0;
  for (let i = 0; i < 2000; i++) {
    const r = await R.consume({ policyId: p.policyId, subject: 'u' + (i % 100) });
    if (r.allowed) allowed += 1;
  }
  const elapsed = Date.now() - start;
  // 100 subjects × limit 10 = 1000 allowed; the other 1000 blocked
  assert.equal(allowed, 1000);
  assert.ok(elapsed < 3000, `expected < 3s, took ${elapsed}ms`);
  assert.ok(rl.ratelimit.metrics().cacheHits > 0); // usage cache engaged
  assert.equal((await R.verify({ namespace: 'default' })).ok, true);
});

test('policy checksum is stable across re-hydration (recompute equal)', async () => {
  const clock = makeClock();
  const rl = createRateLimitPlatform({ clock });
  const p = await rl.ratelimit.registerPolicy({ name: 'api', limit: 1, window: 1000 });
  const model = await rl.provider.getPolicy('default', p.policyId);
  assert.equal(model.checksum, computeChecksum(fromModel(model)));
});
