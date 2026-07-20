'use strict';

/**
 * Enterprise Configuration Platform tests (Phase 14.3.2) — covers every required
 * category: unit (precedence, schema, redaction, cache, metrics), provider,
 * validation, reload, rollback, subscription, integration (events via port),
 * concurrency, and performance.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const precedence = require('../../src/domain/config/precedence');
const schema = require('../../src/domain/config/schema');
const redaction = require('../../src/domain/config/redaction');
const { createConfigCache } = require('../../src/application/config/cache');
const { createConfigMetrics } = require('../../src/application/config/metrics');
const { createConfigurationPlatform, providers } = require('../../src/application/config');
const { toReadConfigPort, toConfigProvider } = require('../../src/application/config/sdkAdapter');

const fixedClock = () => '2026-07-20T00:00:00.000Z';

function recordingPublisher() {
  const events = [];
  return { events, publish: (e) => (events.push(e), Promise.resolve()) };
}

// ── domain: precedence (deterministic) ────────────────────────────────────────

test('precedence: higher layer wins; resolution is deterministic', () => {
  const layers = {
    runtime: { a: 'runtime' },
    tenant: { a: 'tenant', b: 'tenant' },
    default: { a: 'default', b: 'default', c: 'default' },
  };
  const r1 = precedence.resolve(layers);
  const r2 = precedence.resolve(layers);
  assert.deepEqual(r1, r2); // deterministic
  assert.equal(r1.values.a, 'runtime');
  assert.equal(r1.values.b, 'tenant');
  assert.equal(r1.values.c, 'default');
  assert.equal(r1.origins.a, 'runtime');
  assert.equal(r1.origins.b, 'tenant');
});

test('precedence: full order runtime→tenant→org→env→provider→file→default', () => {
  const one = (layer) => ({ [layer]: { k: layer } });
  const order = ['runtime', 'tenant', 'organization', 'environment', 'provider', 'file', 'default'];
  for (let i = 0; i < order.length; i++) {
    const layers = {};
    for (const l of order.slice(i)) Object.assign(layers, one(l));
    assert.equal(precedence.resolve(layers).values.k, order[i]);
  }
});

// ── domain: schema validation ─────────────────────────────────────────────────

test('schema: required/default/type/enum/min/max/pattern/custom/nested/array', () => {
  const s = {
    required: ['name'],
    properties: {
      name: { type: 'string', min: 2, pattern: '^[a-z]+$' },
      level: { type: 'string', enum: ['low', 'high'], default: 'low' },
      port: { type: 'integer', min: 1, max: 65535 },
      ratio: { type: 'number', validate: (v) => v <= 1 || 'must be <= 1' },
      tags: { type: 'array', items: { type: 'string' } },
      db: { type: 'object', properties: { host: { type: 'string', default: 'localhost' } } },
    },
  };
  const ok = schema.validate({ name: 'abc', port: 8080, ratio: 0.5, tags: ['x', 'y'], db: {} }, s);
  assert.ok(ok.ok, ok.errors.join(';'));
  assert.equal(ok.value.level, 'low'); // default
  assert.equal(ok.value.db.host, 'localhost'); // nested default

  const bad = schema.validate({ name: 'A1', port: 70000, level: 'mid', ratio: 2, tags: [1] }, s);
  assert.ok(!bad.ok);
  // pattern, max, enum, custom, array-item type, and required-name all fail
  assert.ok(bad.errors.length >= 5, bad.errors.join(';'));
});

test('schema: missing required with no default is rejected', () => {
  const s = { properties: { token: { type: 'string', required: true } } };
  const r = schema.validate({}, s);
  assert.ok(!r.ok);
  assert.match(r.errors[0], /required/);
});

// ── domain: redaction ─────────────────────────────────────────────────────────

test('redaction: masks passwords/tokens/keys/credentials, keeps plain values', () => {
  const values = {
    'http.port': 8080,
    'db.password': 'hunter2',
    'api.token': 'abc',
    'service.apiKey': 'k',
    'aws.secret': 's',
    'x.credential': 'c',
    'feature.enabled': true,
  };
  const out = redaction.redact(values);
  assert.equal(out['http.port'], 8080);
  assert.equal(out['feature.enabled'], true);
  for (const k of ['db.password', 'api.token', 'service.apiKey', 'aws.secret', 'x.credential']) {
    assert.equal(out[k], redaction.REDACTED, `expected ${k} redacted`);
  }
});

// ── unit: cache ────────────────────────────────────────────────────────────────

test('cache: lazy load, hit/miss tracking, invalidation, version + freshness', async () => {
  const cache = createConfigCache();
  let builds = 0;
  const loader = async () => ({ values: { a: 1 }, origins: {}, version: 1, build: ++builds });
  const first = await cache.getOrLoad(loader); // miss → build
  const second = await cache.getOrLoad(loader); // hit → no build
  assert.equal(first.build, 1);
  assert.equal(second.build, 1);
  assert.ok(cache.isFresh(1));
  assert.ok(!cache.isFresh(2));
  cache.invalidate();
  await cache.getOrLoad(loader); // miss → build again
  assert.equal(builds, 2);
  const s = cache.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 2);
  assert.ok(Math.abs(s.hitRatio - 1 / 3) < 1e-9);
});

// ── unit: metrics + prometheus ────────────────────────────────────────────────

test('metrics: records reload/validation/cache/subscribers + prometheus exposition', async () => {
  const m = createConfigMetrics({ clock: () => 0 });
  await m.timeProvider('env', async () => 'x');
  m.recordReload(5);
  m.recordValidationFailure();
  m.recordCache(true);
  m.recordCache(false);
  m.setSubscriberCount(3);
  m.recordWatchNotification();
  const s = m.snapshot();
  assert.equal(s.reloadCount, 1);
  assert.equal(s.validationFailures, 1);
  assert.equal(s.cacheHitRatio, 0.5);
  assert.equal(s.subscriberCount, 3);
  assert.equal(s.watchNotifications, 1);
  const prom = m.prometheus();
  assert.match(prom, /config_reload_total 1/);
  assert.match(prom, /config_cache_hit_ratio 0\.5/);
  assert.match(prom, /provider="env"/);
});

// ── provider adapters ──────────────────────────────────────────────────────────

test('providers: env transforms keys; jsonFile flattens; memory watches', async () => {
  const env = providers.createEnvProvider({
    source: { APP_HTTP_PORT: '8080', OTHER: 'x' },
    prefix: 'APP_',
  });
  assert.deepEqual(await env.load(), { 'http.port': '8080' });

  const json = providers.createJsonFileProvider({
    path: 'x.json',
    readFile: () => JSON.stringify({ db: { host: 'h', port: 5432 }, flag: true }),
  });
  assert.deepEqual(await json.load(), { 'db.host': 'h', 'db.port': 5432, flag: true });

  const mem = providers.createMemoryProvider({ initial: { a: 1 } });
  let hits = 0;
  const un = mem.watch(() => hits++);
  mem.set('a', 2);
  mem.setAll({ b: 3 });
  un();
  mem.set('a', 4);
  assert.equal(hits, 2); // unsubscribed before the third change
});

test('providers: future provider extension points are declared, not implemented', async () => {
  assert.ok(providers.FUTURE_PROVIDERS.includes('vault'));
  const p = providers.futureProvider('redis');
  assert.equal(p.planned, true);
  await assert.rejects(() => p.load(), /extension point/);
});

// ── integration: platform end-to-end + events via port ────────────────────────

test('config: precedence + defaults + redacted snapshot + events on init', async () => {
  const pub = recordingPublisher();
  const mem = providers.createMemoryProvider({
    layer: 'provider',
    initial: { 'http.port': 8080, 'db.password': 'secret' },
  });
  const cfg = createConfigurationPlatform({
    defaults: { 'http.port': 3000, 'http.host': 'localhost' },
    providers: [mem],
    schema: {
      properties: {
        'http.port': { type: 'integer', min: 1, max: 65535 },
        'http.host': { type: 'string' },
      },
    },
    publisher: pub,
    clock: fixedClock,
  });
  const r = await cfg.init();
  assert.ok(r.ok);
  assert.equal(cfg.service.get('http.port'), 8080); // provider beats default
  assert.equal(cfg.service.get('http.host'), 'localhost'); // default
  assert.equal(cfg.service.require('http.port'), 8080);
  assert.throws(() => cfg.service.require('missing.key'), /missing/);
  assert.ok(cfg.service.exists('db.password'));
  assert.equal(cfg.service.snapshot().values['db.password'], redaction.REDACTED);
  assert.deepEqual(cfg.service.list('http.'), ['http.host', 'http.port']);
  const types = pub.events.map((e) => e.type);
  assert.ok(types.includes('ConfigurationReloaded'));
  assert.ok(pub.events.every((e) => e.producer === 'config'));
});

// ── reload + subscription ──────────────────────────────────────────────────────

test('config: live reload notifies watchers with old/new/version/origin/timestamp', async () => {
  const mem = providers.createMemoryProvider({ layer: 'provider', initial: { 'x.y': 1 } });
  const cfg = createConfigurationPlatform({ providers: [mem], clock: fixedClock });
  await cfg.init();
  const seen = [];
  const un = cfg.service.watch('x.y', (c) => seen.push(c));
  await cfg.service.reload(); // no change → no notify
  mem.set('x.y', 2);
  await new Promise((r) => setTimeout(r, 5)); // provider watch → auto reload
  assert.equal(seen.length, 1);
  assert.deepEqual(
    { old: seen[0].oldValue, neu: seen[0].newValue, v: seen[0].version },
    { old: 1, neu: 2, v: 2 }
  );
  assert.equal(seen[0].origin, 'provider');
  assert.equal(seen[0].timestamp, fixedClock());
  un();
  mem.set('x.y', 3);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen.length, 1); // unsubscribed
});

// ── rollback ────────────────────────────────────────────────────────────────────

test('config: invalid reload rolls back + publishes ValidationFailed & Rollback', async () => {
  const pub = recordingPublisher();
  const mem = providers.createMemoryProvider({ layer: 'provider', initial: { 'http.port': 8080 } });
  const cfg = createConfigurationPlatform({
    providers: [mem],
    schema: { properties: { 'http.port': { type: 'integer', min: 1, max: 65535 } } },
    publisher: pub,
    clock: fixedClock,
  });
  await cfg.init();
  const before = cfg.service.version();
  mem.set('http.port', 99999999); // out of range
  const r = await cfg.service.reload();
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, true);
  assert.equal(cfg.service.get('http.port'), 8080); // previous good value retained
  assert.equal(cfg.service.version(), before); // version unchanged on rollback
  const types = pub.events.map((e) => e.type);
  assert.ok(types.includes('ConfigurationValidationFailed'));
  assert.ok(types.includes('ConfigurationRollback'));
});

test('config: invalid INITIAL config cannot activate (throws)', async () => {
  const mem = providers.createMemoryProvider({ layer: 'provider', initial: { 'http.port': -1 } });
  const cfg = createConfigurationPlatform({
    providers: [mem],
    schema: { properties: { 'http.port': { type: 'integer', min: 1 } } },
  });
  await assert.rejects(() => cfg.init(), /initial configuration invalid/);
});

// ── runtime override tier ────────────────────────────────────────────────────

test('config: runtime override beats provider; clearOverride restores', async () => {
  const mem = providers.createMemoryProvider({ layer: 'provider', initial: { k: 'provider' } });
  const cfg = createConfigurationPlatform({ providers: [mem], clock: fixedClock });
  await cfg.init();
  assert.equal(cfg.service.get('k'), 'provider');
  await cfg.service.setOverride('runtime', 'k', 'runtime');
  assert.equal(cfg.service.get('k'), 'runtime');
  await cfg.service.clearOverride('runtime', 'k');
  assert.equal(cfg.service.get('k'), 'provider');
});

// ── SDK integration adapter ────────────────────────────────────────────────────

test('config: SDK adapter yields a read:config port + provider fn (prefix-scoped)', async () => {
  const mem = providers.createMemoryProvider({
    layer: 'provider',
    initial: { 'ext.surge.maxMultiplier': 3, 'http.port': 8080 },
  });
  const cfg = createConfigurationPlatform({ providers: [mem], clock: fixedClock });
  await cfg.init();
  const port = toReadConfigPort(cfg.service, { prefix: 'ext.surge.' });
  assert.deepEqual(await port.get(), { maxMultiplier: 3 }); // scoped + stripped
  const provider = toConfigProvider(cfg.service, { prefix: 'ext.surge.' });
  assert.deepEqual(provider(), { maxMultiplier: 3 });
});

// ── concurrency ──────────────────────────────────────────────────────────────

test('config: concurrent reloads converge to a single deterministic snapshot', async () => {
  const mem = providers.createMemoryProvider({ layer: 'provider', initial: { n: 0 } });
  const cfg = createConfigurationPlatform({ providers: [mem], clock: fixedClock });
  await cfg.init();
  mem.setAll({ n: 42 });
  const results = await Promise.all([
    cfg.service.reload(),
    cfg.service.reload(),
    cfg.service.reload(),
    cfg.service.reload(),
  ]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(cfg.service.get('n'), 42); // consistent final value
  // Snapshot is internally consistent (values match a single resolution).
  const snap = cfg.service.snapshot({ redact: false });
  assert.equal(snap.values.n, 42);
});

// ── performance ────────────────────────────────────────────────────────────────

test('config: 10k cached reads are fast (<150ms) and correct', async () => {
  const bag = {};
  for (let i = 0; i < 500; i++) bag['k' + i] = i;
  const mem = providers.createMemoryProvider({ layer: 'provider', initial: bag });
  const cfg = createConfigurationPlatform({ providers: [mem], clock: fixedClock });
  await cfg.init();
  const start = Date.now();
  let acc = 0;
  for (let i = 0; i < 10000; i++) acc += cfg.service.get('k' + (i % 500));
  const elapsed = Date.now() - start;
  assert.ok(acc > 0);
  assert.ok(elapsed < 150, `reads too slow: ${elapsed}ms`);
});
