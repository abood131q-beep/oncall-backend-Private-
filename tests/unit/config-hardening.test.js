'use strict';

/**
 * Configuration Platform — production hardening tests (Phase 14.3.2 completion).
 * Additive: exercises concurrent-reload protection, provider timeout + graceful
 * failure, corrupted config, rollback verification, cache integrity, snapshot
 * immutability, version history, stale detection, diagnostics, and stress.
 * Does not modify or duplicate the existing config.test.js coverage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createConfigurationPlatform, providers } = require('../../src/application/config');

const fixedClock = () => '2026-07-20T00:00:00.000Z';
const monotonicClock = (() => {
  let n = 0;
  return () => `t${n++}`;
})();

// ── concurrent reload protection (race) ────────────────────────────────────────

test('hardening: concurrent reloads serialize + coalesce; version stays monotonic', async () => {
  const mem = providers.createMemoryProvider({ layer: 'provider', initial: { n: 0 } });
  const cfg = createConfigurationPlatform({ providers: [mem], clock: monotonicClock });
  await cfg.init();
  const base = cfg.service.version();

  // Fire many reloads at once against a changing source.
  mem.setAll({ n: 1 });
  const burst = await Promise.all(Array.from({ length: 25 }, () => cfg.service.reload()));
  assert.ok(burst.every((r) => r.ok));
  // Version advanced by a bounded, monotonic amount — never a duplicate/lost bump.
  const v = cfg.service.version();
  assert.ok(v >= base + 1 && v <= base + 2, `version ${v} vs base ${base}`);
  assert.equal(cfg.service.get('n'), 1);
  // Cache agrees with the active snapshot after the storm.
  assert.equal(cfg.service.verifyCache().ok, true);
});

test('hardening: interleaved distinct changes converge to the latest value', async () => {
  const mem = providers.createMemoryProvider({ layer: 'provider', initial: { n: 0 } });
  const cfg = createConfigurationPlatform({ providers: [mem], clock: monotonicClock });
  await cfg.init();
  const ps = [];
  for (let i = 1; i <= 20; i++) {
    mem.set('n', i);
    ps.push(cfg.service.reload());
  }
  await Promise.all(ps);
  assert.equal(cfg.service.get('n'), 20); // last write wins, deterministically
  assert.equal(cfg.service.verifyCache().ok, true);
});

// ── provider timeout + graceful failure ────────────────────────────────────────

test('hardening: a hanging provider times out and falls back to last-known-good', async () => {
  let hang = false;
  const flaky = {
    name: 'flaky',
    layer: 'provider',
    load() {
      if (hang) return new Promise(() => {}); // never resolves
      return Promise.resolve({ 'a.b': 1 });
    },
  };
  const cfg = createConfigurationPlatform({ providers: [flaky], providerTimeoutMs: 20 });
  await cfg.init();
  assert.equal(cfg.service.get('a.b'), 1);
  hang = true; // next reload will time out
  const r = await cfg.service.reload();
  assert.ok(r.ok); // graceful: last-known-good reused, no throw
  assert.equal(cfg.service.get('a.b'), 1);
  assert.ok(cfg.service.metrics().providerErrors >= 1);
});

test('hardening: a throwing provider with NO history fails startup loudly', async () => {
  const broken = {
    name: 'broken',
    layer: 'provider',
    load: () => Promise.reject(new Error('source down')),
  };
  const cfg = createConfigurationPlatform({ providers: [broken] });
  await assert.rejects(() => cfg.init(), /source down/);
});

// ── corrupted configuration ────────────────────────────────────────────────────

test('hardening: corrupted JSON file surfaces as a provider error, not a crash', async () => {
  const good = providers.createMemoryProvider({ layer: 'provider', initial: { k: 'ok' } });
  const corrupt = providers.createJsonFileProvider({
    path: 'bad.json',
    readFile: () => '{ this is : not json',
  });
  // Corrupt provider has no last-known-good → initial load rejects.
  const cfg = createConfigurationPlatform({ providers: [good, corrupt] });
  await assert.rejects(() => cfg.init(), /invalid JSON/);
});

// ── rollback verification ────────────────────────────────────────────────────

test('hardening: invalid reload keeps the exact previous immutable snapshot', async () => {
  const mem = providers.createMemoryProvider({ layer: 'provider', initial: { 'http.port': 8080 } });
  const cfg = createConfigurationPlatform({
    providers: [mem],
    schema: { properties: { 'http.port': { type: 'integer', min: 1, max: 65535 } } },
    clock: fixedClock,
  });
  await cfg.init();
  const before = cfg.service.snapshot({ redact: false });
  mem.set('http.port', -5);
  const r = await cfg.service.reload();
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, true);
  const after = cfg.service.snapshot({ redact: false });
  assert.deepEqual(after.values, before.values);
  assert.equal(after.version, before.version);
});

// ── cache integrity ────────────────────────────────────────────────────────────

test('hardening: verifyCache reports consistency across reloads', async () => {
  const mem = providers.createMemoryProvider({ layer: 'provider', initial: { a: 1 } });
  const cfg = createConfigurationPlatform({ providers: [mem], clock: monotonicClock });
  await cfg.init();
  assert.equal(cfg.service.verifyCache().ok, true);
  mem.set('a', 2);
  await cfg.service.reload();
  const v = cfg.service.verifyCache();
  assert.equal(v.ok, true);
  assert.equal(v.cacheVersion, v.currentVersion);
});

// ── snapshot immutability ────────────────────────────────────────────────────

test('hardening: snapshots are deeply immutable (frozen values + origins)', async () => {
  const mem = providers.createMemoryProvider({
    layer: 'provider',
    initial: { a: 1, 'nested.k': 'v' },
  });
  const cfg = createConfigurationPlatform({ providers: [mem], clock: monotonicClock });
  await cfg.init();
  const snap = cfg.service.snapshot({ redact: false });
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.values));
  assert.ok(Object.isFrozen(snap.origins));
  assert.throws(() => {
    snap.values.a = 999;
  }, TypeError);
  // Mutating a returned snapshot never affects the live config.
  assert.equal(cfg.service.get('a'), 1);
});

// ── version history + stale detection ──────────────────────────────────────────

test('hardening: version history retains snapshots; snapshotAt + isStale work', async () => {
  const mem = providers.createMemoryProvider({ layer: 'provider', initial: { n: 1 } });
  const cfg = createConfigurationPlatform({
    providers: [mem],
    clock: monotonicClock,
    historyLimit: 3,
  });
  await cfg.init(); // v1
  for (const n of [2, 3, 4, 5]) {
    mem.set('n', n);
    await cfg.service.reload();
  }
  const hist = cfg.service.history();
  assert.ok(hist.length <= 3, 'history bounded by limit'); // ring buffer
  const latest = cfg.service.version();
  assert.ok(cfg.service.snapshotAt(latest)); // present
  assert.equal(cfg.service.snapshotAt(1), null); // evicted
  assert.equal(cfg.service.isStale(latest), false);
  assert.equal(cfg.service.isStale(latest - 1), true);
});

test('hardening: history snapshots are redacted (no secrets retained in the open)', async () => {
  const mem = providers.createMemoryProvider({
    layer: 'provider',
    initial: { 'db.password': 'p1' },
  });
  const cfg = createConfigurationPlatform({ providers: [mem], clock: monotonicClock });
  await cfg.init();
  const snap = cfg.service.snapshotAt(cfg.service.version());
  assert.notEqual(snap.values['db.password'], 'p1'); // redacted in history view
});

// ── diagnostics ────────────────────────────────────────────────────────────────

test('hardening: diagnostics expose structured health', async () => {
  const mem = providers.createMemoryProvider({ layer: 'provider', initial: { a: 1 } });
  const cfg = createConfigurationPlatform({ providers: [mem], clock: monotonicClock });
  await cfg.init();
  const d = cfg.service.diagnostics();
  assert.equal(typeof d.version, 'number');
  assert.equal(d.cache.ok, true);
  assert.equal(d.providers[0].name, 'memory');
  assert.equal(d.providers[0].lastKnownGood, true);
  assert.equal(d.reloadInFlight, false);
  assert.ok(d.metrics);
});

// ── stress ────────────────────────────────────────────────────────────────────

test('hardening: stress — 200 rapid mutations remain consistent', async () => {
  const mem = providers.createMemoryProvider({ layer: 'provider', initial: { n: 0 } });
  const cfg = createConfigurationPlatform({ providers: [mem], clock: monotonicClock });
  await cfg.init();
  const ps = [];
  for (let i = 1; i <= 200; i++) {
    mem.set('n', i);
    ps.push(cfg.service.reload());
  }
  await Promise.all(ps);
  assert.equal(cfg.service.get('n'), 200);
  assert.equal(cfg.service.verifyCache().ok, true);
  // Version is monotonic and never exceeds the number of reloads.
  assert.ok(cfg.service.version() >= 2);
});
