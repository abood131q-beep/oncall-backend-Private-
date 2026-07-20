'use strict';

/**
 * Enterprise Policy tests (Phase 14.6 / ADR-025) — covers every required
 * category: unit (condition, policy, decision engine), evaluation, conflict
 * resolution, performance, concurrency, and failure injection, plus events-via-
 * port, decision cache, integrity verification, and the SDK owner-scoped adapter
 * (namespace isolation + capability gates). Deterministic: clock injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const condition = require('../../src/domain/policy/condition');
const { createPolicy } = require('../../src/domain/policy/policy');
const decisionEngine = require('../../src/domain/policy/decision');
const { createPolicyPlatform, providers } = require('../../src/application/policy');
const { createPolicyMetrics } = require('../../src/application/policy/metrics');
const { toPolicyPort } = require('../../src/application/policy/sdkAdapter');
const { PolicyDefinitionError } = require('../../src/domain/policy/errors');

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

// ── domain: condition ──────────────────────────────────────────────────────────

test('condition: operators + composition (all/any/not) are deterministic', () => {
  const ctx = { user: { tier: 'vip', age: 30 }, tags: ['a', 'b'], name: 'abc' };
  assert.equal(condition.evaluate({ field: 'user.tier', op: 'eq', value: 'vip' }, ctx), true);
  assert.equal(condition.evaluate({ field: 'user.age', op: 'gte', value: 18 }, ctx), true);
  assert.equal(condition.evaluate({ field: 'tags', op: 'contains', value: 'b' }, ctx), true);
  assert.equal(condition.evaluate({ field: 'name', op: 'regex', value: '^a' }, ctx), true);
  assert.equal(condition.evaluate({ field: 'missing', op: 'exists', value: false }, ctx), true);
  assert.equal(
    condition.evaluate(
      {
        all: [
          { field: 'user.tier', op: 'eq', value: 'vip' },
          { field: 'user.age', op: 'gt', value: 18 },
        ],
      },
      ctx
    ),
    true
  );
  assert.equal(
    condition.evaluate(
      {
        any: [
          { field: 'user.tier', op: 'eq', value: 'gold' },
          { field: 'user.age', op: 'gt', value: 18 },
        ],
      },
      ctx
    ),
    true
  );
  assert.equal(
    condition.evaluate({ not: { field: 'user.tier', op: 'eq', value: 'gold' } }, ctx),
    true
  );
  assert.equal(condition.evaluate(true, ctx), true); // unconditional
  assert.throws(
    () => condition.evaluate({ field: 'x', op: 'bogus', value: 1 }, ctx),
    /unknown operator/
  );
});

// ── domain: policy ─────────────────────────────────────────────────────────────

test('policy: validation, checksum, scope matching', () => {
  const p = createPolicy({ name: 'p', scope: 'trip:create', effect: 'allow', condition: true });
  assert.equal(p.effect, 'allow');
  assert.ok(p.policyId.startsWith('pol_'));
  assert.equal(typeof p.checksum, 'string');
  assert.equal(p.checksum.length, 64);
  assert.ok(p.appliesToScope('trip:create'));
  assert.ok(!p.appliesToScope('other'));
  assert.ok(createPolicy({ name: 'wild', scope: '*', effect: 'deny' }).appliesToScope('anything'));
  assert.throws(() => createPolicy({ name: 'x' }), PolicyDefinitionError); // missing scope
  assert.throws(
    () => createPolicy({ name: 'x', scope: 's', effect: 'maybe' }),
    PolicyDefinitionError
  );
});

// ── domain: decision engine + conflict resolution ─────────────────────────────

test('decision: default-deny, deny-overrides, allow-overrides, priority, first-applicable', () => {
  const allow = createPolicy({
    name: 'allow',
    scope: 's',
    effect: 'allow',
    priority: 5,
    condition: true,
  });
  const deny = createPolicy({
    name: 'deny',
    scope: 's',
    effect: 'deny',
    priority: 10,
    condition: true,
  });
  const pols = [allow, deny];
  const req = { scope: 's' };
  assert.equal(decisionEngine.evaluate([], req).decision, 'deny'); // default deny
  assert.equal(decisionEngine.evaluate(pols, req, { strategy: 'deny-overrides' }).decision, 'deny');
  assert.equal(
    decisionEngine.evaluate(pols, req, { strategy: 'allow-overrides' }).decision,
    'allow'
  );
  // priority: highest-priority applicable = deny (10)
  assert.equal(decisionEngine.evaluate(pols, req, { strategy: 'priority' }).decision, 'deny');
  // first-applicable in priority order → deny first
  assert.equal(
    decisionEngine.evaluate(pols, req, { strategy: 'first-applicable' }).decision,
    'deny'
  );
});

test('decision: scope filtering + non-applicable conditions', () => {
  const p = createPolicy({
    name: 'p',
    scope: 'a',
    effect: 'allow',
    condition: { field: 'ok', op: 'eq', value: true },
  });
  assert.equal(decisionEngine.evaluate([p], { scope: 'b', ok: true }).decision, 'deny'); // wrong scope → default deny
  assert.equal(decisionEngine.evaluate([p], { scope: 'a', ok: false }).decision, 'deny'); // condition false
  assert.equal(decisionEngine.evaluate([p], { scope: 'a', ok: true }).decision, 'allow');
});

// ── unit: metrics ──────────────────────────────────────────────────────────────

test('metrics: counters + prometheus', () => {
  const m = createPolicyMetrics();
  m.recordRegistered();
  m.recordDecision(true);
  m.recordDecision(false);
  m.recordCache(true);
  m.recordCache(false);
  const s = m.snapshot();
  assert.equal(s.registered, 1);
  assert.equal(s.allow, 1);
  assert.equal(s.deny, 1);
  assert.equal(s.cacheHitRatio, 0.5);
  assert.match(m.prometheus(), /policy_allow_total 1/);
  assert.match(m.prometheus(), /policy_cache_hit_ratio 0\.5/);
});

// ── provider + future extension points ─────────────────────────────────────────

test('provider: memory stores definitions; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.put('n', { policyId: 'p1', name: 'x' });
  assert.equal((await mem.get('n', 'p1')).name, 'x');
  assert.equal((await mem.list('n')).length, 1);
  assert.equal(await mem.remove('n', 'p1'), true);
  assert.ok(providers.FUTURE_PROVIDERS.includes('opa'));
  const p = providers.futureProvider('cedar');
  assert.equal(p.planned, true);
  assert.throws(() => p.put('n', {}), /extension point/);
});

// ── service: evaluate + events + persistence ───────────────────────────────────

test('policy: register + evaluate with events via port', async () => {
  const clock = makeClock();
  const pub = recordingPublisher();
  const pol = createPolicyPlatform({ clock, publisher: pub });
  const P = pol.policy;
  await P.register({
    name: 'allow-vip',
    scope: 'trip:create',
    effect: 'allow',
    priority: 10,
    condition: { field: 'user.tier', op: 'eq', value: 'vip' },
  });
  await P.register({
    name: 'deny-night',
    scope: 'trip:create',
    effect: 'deny',
    priority: 20,
    condition: { field: 'hour', op: 'gte', value: 23 },
  });
  assert.equal(
    (await P.evaluate({ scope: 'trip:create', user: { tier: 'vip' }, hour: 12 })).allowed,
    true
  );
  assert.equal(
    (await P.evaluate({ scope: 'trip:create', user: { tier: 'vip' }, hour: 23 })).allowed,
    false
  ); // deny-overrides
  assert.equal(
    (await P.evaluate({ scope: 'trip:create', user: { tier: 'basic' }, hour: 12 })).allowed,
    false
  ); // default deny
  const types = pub.events.map((e) => e.type);
  assert.ok(
    types.includes('PolicyRegistered') &&
      types.includes('PolicyEvaluated') &&
      types.includes('PolicyRejected')
  );
  assert.ok(pub.events.every((e) => e.producer === 'policy'));
  // definitions persisted to the provider
  assert.equal((await pol.provider.list('default')).length, 2);
});

// ── explain ────────────────────────────────────────────────────────────────────

test('policy: explain returns a full per-policy trace', async () => {
  const clock = makeClock();
  const pol = createPolicyPlatform({ clock });
  await pol.policy.register({ name: 'a', scope: 's', effect: 'allow', condition: true });
  const ex = await pol.policy.explain({ scope: 's' });
  assert.equal(ex.allowed, true);
  assert.ok(Array.isArray(ex.evaluated));
  assert.equal(ex.evaluated[0].name, 'a');
  assert.ok(ex.decidingPolicy);
});

// ── decision cache ──────────────────────────────────────────────────────────────

test('policy: decisions are cached and invalidated on change', async () => {
  const clock = makeClock();
  const pol = createPolicyPlatform({ clock });
  const P = pol.policy;
  await P.register({ name: 'a', scope: 's', effect: 'allow', condition: true });
  const req = { scope: 's', x: 1 };
  await P.evaluate(req); // miss
  await P.evaluate(req); // hit
  assert.equal(P.metrics().cacheHits, 1);
  assert.equal(P.metrics().cacheMisses, 1);
  // A new registration invalidates the cache.
  await P.register({ name: 'b', scope: 's', effect: 'deny', priority: 100, condition: true });
  const after = await P.evaluate(req); // miss again → now denied (deny-overrides)
  assert.equal(after.allowed, false);
  assert.equal(P.metrics().cacheMisses, 2);
});

// ── enable / disable ────────────────────────────────────────────────────────────

test('policy: disable removes a policy from evaluation; enable restores', async () => {
  const clock = makeClock();
  const pol = createPolicyPlatform({ clock });
  const P = pol.policy;
  const deny = await P.register({
    name: 'deny-all',
    scope: 's',
    effect: 'deny',
    priority: 100,
    condition: true,
  });
  await P.register({ name: 'allow', scope: 's', effect: 'allow', condition: true });
  assert.equal((await P.evaluate({ scope: 's' })).allowed, false); // deny wins
  await P.disable('default', deny.policyId);
  assert.equal((await P.evaluate({ scope: 's' })).allowed, true); // deny gone → allow
  await P.enable('default', deny.policyId);
  assert.equal((await P.evaluate({ scope: 's' })).allowed, false);
});

// ── integrity verification ──────────────────────────────────────────────────────

test('policy: integrity verification passes for registered policies', async () => {
  const clock = makeClock();
  const pol = createPolicyPlatform({ clock });
  await pol.policy.register({
    name: 'a',
    scope: 's',
    effect: 'allow',
    condition: { field: 'x', op: 'eq', value: 1 },
  });
  const v = pol.policy.verify('default');
  assert.equal(v.ok, true);
  assert.equal(v.issues.length, 0);
});

// ── SDK adapter: namespace isolation + capability gates ─────────────────────────

test('policy SDK adapter: namespace isolation + capability enforcement', async () => {
  const clock = makeClock();
  const pol = createPolicyPlatform({ clock });
  const portA = toPolicyPort(pol.policy, { owner: 'ext-a' });
  const portB = toPolicyPort(pol.policy, { owner: 'ext-b' });
  await portA.register({ name: 'a-allow', scope: 's', effect: 'allow', condition: true });
  // B has no policy for scope 's' in its own namespace → default deny (isolated from A).
  assert.equal((await portB.evaluate({ scope: 's' })).allowed, false);
  assert.equal((await portA.evaluate({ scope: 's' })).allowed, true);
  assert.equal(portA.list({}).length, 1);
  assert.equal(portB.list({}).length, 0);

  const readonly = toPolicyPort(pol.policy, { owner: 'ext-c', canEvaluate: false });
  await assert.rejects(async () => readonly.evaluate({ scope: 's' }), /policy:evaluate/);
});

// ── failure injection ──────────────────────────────────────────────────────────

test('failure injection: a throwing custom condition is fail-safe (non-applicable)', async () => {
  const clock = makeClock();
  const pol = createPolicyPlatform({ clock });
  await pol.policy.register({
    name: 'buggy',
    scope: 's',
    effect: 'allow',
    condition: {
      fn: () => {
        throw new Error('boom');
      },
    },
  });
  const r = await pol.policy.explain({ scope: 's' });
  assert.equal(r.allowed, false); // throwing condition → not applicable → default deny
  assert.ok(r.evaluated[0].error); // error captured in the trace
});

// ── concurrency + performance ────────────────────────────────────────────────

test('policy: concurrent evaluations are consistent', async () => {
  const clock = makeClock();
  const pol = createPolicyPlatform({ clock });
  await pol.policy.register({
    name: 'allow-even',
    scope: 's',
    effect: 'allow',
    condition: { field: 'n', op: 'gte', value: 0 },
  });
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, n) => pol.policy.evaluate({ scope: 's', n }))
  );
  assert.ok(results.every((r) => r.allowed === true));
});

test('policy: performance — 10k evaluations complete quickly', async () => {
  const clock = makeClock();
  const pol = createPolicyPlatform({ clock });
  await pol.policy.register({
    name: 'allow-vip',
    scope: 's',
    effect: 'allow',
    condition: { field: 'tier', op: 'eq', value: 'vip' },
  });
  const start = Date.now();
  let allowed = 0;
  for (let i = 0; i < 10000; i++) {
    const r = await pol.policy.evaluate({ scope: 's', tier: i % 2 ? 'vip' : 'basic' });
    if (r.allowed) allowed += 1;
  }
  const elapsed = Date.now() - start;
  assert.equal(allowed, 5000);
  assert.ok(elapsed < 1500, `too slow: ${elapsed}ms`);
});
