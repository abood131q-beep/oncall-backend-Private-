'use strict';

/**
 * Enterprise Feature Flag Kernel tests (Phase 15.0 / ADR-029) — covers every
 * required category: unit (flag value object, checksum, targeting, rollout),
 * evaluation, targeting, rollout, conflict resolution, cache, provider (+ future
 * extension points), concurrency, stress, and failure injection, plus
 * events-via-port and the SDK owner-scoped adapter (namespace isolation +
 * capability gates). Deterministic: clock injected, hashing content-based.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFlag, fromModel, computeChecksum, STATE } = require('../../src/domain/features/flag');
const { evaluateFlag } = require('../../src/domain/features/evaluation');
const { matchVersion, matchValue } = require('../../src/domain/features/targeting');
const { isIncluded, bucketOf } = require('../../src/domain/features/rollout');
const { createFeaturePlatform, providers } = require('../../src/application/features');
const { createFeatureMetrics } = require('../../src/application/features/metrics');
const { createEvaluationCache } = require('../../src/application/features/cache');
const { toFeaturePort } = require('../../src/application/features/sdkAdapter');
const {
  FeatureValidationError,
  FeatureNotFoundError,
  IntegrityError,
} = require('../../src/domain/features/errors');

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

// ── domain: flag value object + checksum ─────────────────────────────────────────

test('flag: create, checksum, state, model round-trip', () => {
  const clock = makeClock(1000);
  const f = createFlag({ name: 'x', defaultValue: true, priority: 5 }, { clock });
  assert.equal(f.state, STATE.ENABLED); // enabled by default
  assert.equal(f.version, 1);
  assert.ok(f.checksum && f.checksum.length === 64);
  assert.ok(f.verifyChecksum());
  // enable/disable bump version + checksum.
  const before = f.checksum;
  clock.set(2000);
  f.disable(clock());
  assert.equal(f.state, STATE.DISABLED);
  assert.equal(f.version, 2);
  assert.notEqual(f.checksum, before);
  // round-trips through a model preserving checksum.
  const re = fromModel(f.toModel(), { clock });
  assert.equal(re.checksum, f.checksum);
  assert.ok(re.verifyChecksum());
  assert.throws(() => createFlag({}), FeatureValidationError);
  assert.throws(
    () => createFlag({ name: 'y', rollout: { percentage: 150 } }),
    FeatureValidationError
  );
});

// ── domain: targeting + rollout primitives ───────────────────────────────────────

test('targeting: value + version matchers', () => {
  assert.equal(matchValue('ios', null), true); // unconstrained
  assert.equal(matchValue('ios', 'ios'), true);
  assert.equal(matchValue('ios', ['ios', 'android']), true);
  assert.equal(matchValue('web', ['ios', 'android']), false);
  assert.equal(matchVersion('1.4.0', '>=1.2.0'), true);
  assert.equal(matchVersion('1.1.0', '>=1.2.0'), false);
  assert.equal(matchVersion(null, '>=1.2.0'), false);
  assert.equal(matchVersion('1.0.0', null), true);
});

test('rollout: deterministic + monotonic buckets', () => {
  assert.equal(isIncluded('k', 0), false);
  assert.equal(isIncluded('k', 100), true);
  // same key → same bucket across calls (deterministic).
  assert.equal(bucketOf('user-42'), bucketOf('user-42'));
  // monotonic ramp: anyone included at 30% is still included at 60%.
  let inc30 = 0;
  let violations = 0;
  for (let i = 0; i < 300; i++) {
    const k = 'u' + i;
    const at30 = isIncluded('flag:' + k, 30);
    const at60 = isIncluded('flag:' + k, 60);
    if (at30) inc30 += 1;
    if (at30 && !at60) violations += 1;
  }
  assert.equal(violations, 0);
  assert.ok(inc30 > 40 && inc30 < 140); // ~30% of 300, with hashing variance
});

// ── domain: evaluation engine (pure) ─────────────────────────────────────────────

test('evaluation: disabled/targeting/rules/rollout/default reasons', () => {
  const base = createFlag(
    {
      name: 'f',
      defaultValue: 'on',
      offValue: 'off',
      platform: ['ios', 'android'],
      appVersion: '>=2.0.0',
      rules: [
        { id: 'beta', priority: 10, when: { segment: 'beta' }, value: 'beta-on' },
        { id: 'low', priority: 1, when: { country: 'US' }, value: 'us-on' },
      ],
    },
    { clock: makeClock() }
  ).toModel();

  // disabled → off
  assert.equal(evaluateFlag({ ...base, state: 'disabled' }, {}).reason, 'disabled');
  // wrong platform → not targeted
  const r1 = evaluateFlag(base, { platform: 'web', appVersion: '2.1.0' });
  assert.equal(r1.reason, 'not_targeted');
  assert.equal(r1.failed, 'platform');
  // version too low → not targeted
  assert.equal(evaluateFlag(base, { platform: 'ios', appVersion: '1.9.0' }).failed, 'appVersion');
  // rule match (higher priority wins even though both match)
  const r2 = evaluateFlag(base, {
    platform: 'ios',
    appVersion: '2.2.0',
    segment: 'beta',
    country: 'US',
  });
  assert.equal(r2.reason, 'rule_match');
  assert.equal(r2.ruleId, 'beta');
  assert.equal(r2.value, 'beta-on');
  // lower-priority rule when higher doesn't match
  const r3 = evaluateFlag(base, { platform: 'ios', appVersion: '2.2.0', country: 'US' });
  assert.equal(r3.ruleId, 'low');
  // fallthrough default
  const r4 = evaluateFlag(base, { platform: 'ios', appVersion: '2.2.0', country: 'CA' });
  assert.equal(r4.reason, 'default');
  assert.equal(r4.value, 'on');
});

test('evaluation: conflict resolution respects declared order on equal priority', () => {
  const f = createFlag(
    {
      name: 'c',
      rules: [
        { id: 'a', priority: 5, when: { g: 1 }, value: 'A' },
        { id: 'b', priority: 5, when: { g: 1 }, value: 'B' },
      ],
    },
    { clock: makeClock() }
  ).toModel();
  assert.equal(evaluateFlag(f, { g: 1 }).ruleId, 'a'); // first declared wins on tie
});

test('evaluation: flag-level rollout include/exclude is deterministic', () => {
  const f = createFlag(
    { name: 'roll', defaultValue: true, offValue: false, rollout: { percentage: 50 } },
    { clock: makeClock() }
  ).toModel();
  const a = evaluateFlag(f, { key: 'user-A' });
  const b = evaluateFlag(f, { key: 'user-A' });
  assert.deepEqual([a.reason, a.value], [b.reason, b.value]); // stable
  assert.ok(['rollout_included', 'rollout_excluded'].includes(a.reason));
});

// ── unit: metrics + cache ─────────────────────────────────────────────────────────

test('metrics: gauges + counters + prometheus', () => {
  const m = createFeatureMetrics({ clock: () => 0 });
  m.bindGauges({ registeredFlags: () => 3, enabledFlags: () => 2, disabledFlags: () => 1 });
  m.recordEvaluation();
  m.recordCacheHit();
  m.recordCacheMiss();
  const s = m.snapshot();
  assert.equal(s.registeredFlags, 3);
  assert.equal(s.enabledFlags, 2);
  assert.equal(s.evaluations, 1);
  assert.match(m.prometheus(), /features_cache_hits_total 1/);
  assert.match(m.prometheus(), /features_enabled_flags 2/);
});

test('cache: FIFO bound + checksum-prefix invalidation', () => {
  const c = createEvaluationCache({ maxSize: 2 });
  c.set('default:f:c1:x', { v: 1 });
  c.set('default:f:c1:y', { v: 2 });
  c.set('default:f:c1:z', { v: 3 }); // evicts oldest
  assert.equal(c.get('default:f:c1:x'), undefined); // evicted
  assert.equal(c.stats().size, 2);
  c.invalidate('default', 'f');
  assert.equal(c.stats().size, 0);
});

// ── provider + future extension points ───────────────────────────────────────────

test('provider: memory stores definitions; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.putFlag('n', { name: 'k', state: 'enabled' });
  assert.equal((await mem.getFlag('n', 'k')).state, 'enabled');
  assert.equal((await mem.listFlags('n')).length, 1);
  assert.equal(await mem.removeFlag('n', 'k'), true);
  assert.ok(providers.FUTURE_PROVIDERS.includes('storage'));
  assert.ok(providers.FUTURE_PROVIDERS.includes('redis'));
  const p = providers.futureProvider('postgresql');
  assert.equal(p.planned, true);
  assert.throws(() => p.putFlag('n', {}), /extension point/);
});

// ── service: register / evaluate / enable / disable / events ──────────────────────

test('features: register + evaluate + enable/disable lifecycle; events', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const ff = createFeaturePlatform({ clock, publisher: pub });
  const F = ff.features;
  await F.register({ name: 'checkout', defaultValue: 'v2', offValue: 'v1', enabled: false });
  // registered disabled → off value, reason disabled
  const d = await F.evaluate({ name: 'checkout', context: { key: 'u1' } });
  assert.equal(d.reason, 'disabled');
  assert.equal(d.value, 'v1');
  await F.enable({ name: 'checkout' });
  const e = await F.evaluate({ name: 'checkout', context: { key: 'u1' } });
  assert.equal(e.reason, 'default');
  assert.equal(e.value, 'v2');
  await F.disable({ name: 'checkout' });
  assert.equal((await F.evaluate({ name: 'checkout', context: { key: 'u1' } })).served, false);
  const types = pub.events.map((ev) => ev.type);
  assert.ok(
    types.includes('FeatureRegistered') &&
      types.includes('FeatureEnabled') &&
      types.includes('FeatureDisabled') &&
      types.includes('FeatureEvaluated')
  );
  assert.ok(pub.events.every((ev) => ev.producer === 'features'));
  await assert.rejects(
    () => F.register({ name: 'checkout', defaultValue: 1 }),
    FeatureValidationError
  );
  await assert.rejects(() => F.evaluate({ name: 'ghost' }), FeatureNotFoundError);
});

// ── service: update + version targeting + explanation ─────────────────────────────

test('features: update changes definition (new version + checksum); targeting applies', async () => {
  const clock = makeClock();
  const ff = createFeaturePlatform({ clock });
  const F = ff.features;
  const reg = await F.register({ name: 'f', defaultValue: true, appVersion: '>=2.0.0' });
  assert.equal(reg.version, 1);
  // old app version not targeted
  assert.equal(
    (await F.evaluate({ name: 'f', context: { appVersion: '1.0.0' } })).reason,
    'not_targeted'
  );
  const upd = await F.update({ name: 'f', patch: { appVersion: '>=1.0.0', platform: 'ios' } });
  assert.equal(upd.version, 2);
  assert.notEqual(upd.checksum, reg.checksum);
  assert.equal(
    (await F.evaluate({ name: 'f', context: { appVersion: '1.0.0', platform: 'ios' } })).reason,
    'default'
  );
  assert.equal(
    (await F.evaluate({ name: 'f', context: { appVersion: '1.0.0', platform: 'web' } })).failed,
    'platform'
  );
});

// ── cache behavior via the service ────────────────────────────────────────────────

test('features: evaluation cache hits on repeat; invalidated by update', async () => {
  const clock = makeClock();
  const ff = createFeaturePlatform({ clock });
  const F = ff.features;
  await F.register({ name: 'f', defaultValue: true });
  const ctx = { key: 'u1', platform: 'ios' };
  await F.evaluate({ name: 'f', context: ctx });
  await F.evaluate({ name: 'f', context: ctx }); // hit
  let s = ff.metrics.snapshot();
  assert.equal(s.cacheHits, 1);
  assert.equal(s.cacheMisses, 1);
  await F.update({ name: 'f', patch: { defaultValue: false } }); // checksum change → invalidate
  await F.evaluate({ name: 'f', context: ctx }); // miss again
  s = ff.metrics.snapshot();
  assert.equal(s.cacheMisses, 2);
});

// ── integrity ─────────────────────────────────────────────────────────────────────

test('features: tampered definition fails integrity on evaluate + verify', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const ff = createFeaturePlatform({ clock, provider });
  const F = ff.features;
  await F.register({ name: 'f', defaultValue: true });
  // Tamper the stored definition, leaving the old checksum in place.
  const stored = await provider.getFlag('default', 'f');
  await provider.putFlag('default', { ...stored, defaultValue: 'HIJACKED' });
  await assert.rejects(() => F.evaluate({ name: 'f', context: { k: 1 } }), IntegrityError);
  const v = await F.verify({ namespace: 'default' });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.name === 'f' && i.reason === 'checksum mismatch'));
});

test('features: verify is clean for untampered flags; checksum recomputes equal', async () => {
  const clock = makeClock();
  const ff = createFeaturePlatform({ clock });
  await ff.features.register({ name: 'a', defaultValue: true });
  await ff.features.register({ name: 'b', defaultValue: false, rollout: { percentage: 10 } });
  assert.equal((await ff.features.verify({ namespace: 'default' })).ok, true);
  const model = await ff.provider.getFlag('default', 'b');
  assert.equal(model.checksum, computeChecksum(fromModel(model)));
});

// ── SDK adapter: namespace isolation + capability gates + read-only ──────────────

test('sdk: owner-scoped port isolates namespaces + gates + no mutation surface', async () => {
  const clock = makeClock();
  const ff = createFeaturePlatform({ clock });
  // Author flags in the extension namespaces (admin side, forced ext.<owner>).
  await ff.features.register({ name: 'f', defaultValue: 'alice' }, { namespace: 'ext.alice' });
  await ff.features.register({ name: 'f', defaultValue: 'bob' }, { namespace: 'ext.bob' });
  const alice = toFeaturePort(ff.features, { owner: 'alice' });
  const bob = toFeaturePort(ff.features, { owner: 'bob' });
  assert.equal((await alice.evaluate({ name: 'f', context: {} })).value, 'alice');
  assert.equal((await bob.evaluate({ name: 'f', context: {} })).value, 'bob');
  assert.equal((await alice.list()).length, 1); // only own namespace
  assert.equal(typeof alice.register, 'undefined'); // no authoring surface
  // capability gates
  const noEval = toFeaturePort(ff.features, { owner: 'x', canEvaluate: false });
  await assert.rejects(async () => noEval.evaluate({ name: 'f' }), /feature:evaluate/);
  const noRead = toFeaturePort(ff.features, { owner: 'y', canRead: false });
  await assert.rejects(async () => noRead.list(), /feature:read/);
  assert.throws(() => toFeaturePort(ff.features, {}), /owner required/);
});

// ── failure injection ─────────────────────────────────────────────────────────────

test('features: provider failures are counted and surfaced', async () => {
  const clock = makeClock();
  const failing = {
    name: 'failing',
    putFlag: () => Promise.reject(new Error('db down')),
    getFlag: () => Promise.resolve(null),
    listFlags: () => Promise.resolve([]),
    removeFlag: () => Promise.resolve(false),
    health: () => ({ ok: false }),
  };
  const ff = createFeaturePlatform({ clock, provider: failing });
  await assert.rejects(() => ff.features.register({ name: 'f', defaultValue: true }), /db down/);
  assert.ok(ff.metrics.snapshot().providerFailures >= 1);
  assert.equal((await ff.features.health()).ok, false);
});

// ── concurrency ─────────────────────────────────────────────────────────────────

test('features: concurrent enable/disable/update serialize deterministically', async () => {
  const clock = makeClock();
  const ff = createFeaturePlatform({ clock });
  const F = ff.features;
  await F.register({ name: 'f', defaultValue: true });
  await Promise.all([
    F.enable({ name: 'f' }),
    F.update({ name: 'f', patch: { priority: 9 } }),
    F.disable({ name: 'f' }),
  ]);
  const model = await ff.provider.getFlag('default', 'f');
  assert.equal(model.version, 4); // v1 + 3 serialized mutations
  assert.ok(fromModel(model).verifyChecksum());
});

// ── stress ─────────────────────────────────────────────────────────────────────

test('features: stress — 500 flags register + evaluate + verify consistent', async () => {
  const clock = makeClock();
  const ff = createFeaturePlatform({ clock });
  const F = ff.features;
  for (let i = 0; i < 500; i++) {
    await F.register({ name: 'f' + i, defaultValue: true, rollout: { percentage: (i % 100) + 1 } });
  }
  assert.equal(ff.metrics.snapshot().registeredFlags, 500);
  let served = 0;
  for (let i = 0; i < 500; i++) {
    const r = await F.evaluate({ name: 'f' + i, context: { key: 'user-' + i } });
    if (r.served) served += 1;
  }
  assert.ok(served > 0 && served <= 500);
  assert.equal((await F.verify({ namespace: 'default' })).ok, true);
  assert.equal((await F.list()).length, 500);
});
