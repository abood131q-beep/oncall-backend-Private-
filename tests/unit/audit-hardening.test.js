'use strict';

/**
 * Audit Engine — production hardening tests (ADR-026 A-001). Additive: immutable
 * snapshot, startup + provider (namespace-consistency) verification, chain
 * reconciliation + recovery boundary, query-determinism verification, corruption
 * detection, lifecycle + query history, diagnostics, and expanded metrics.
 * Does not duplicate audit.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAuditPlatform, providers } = require('../../src/application/audit');

function makeClock(start = 1000) {
  const box = { now: start };
  const clock = () => box.now;
  clock.tick = (d = 1) => (box.now += d);
  return clock;
}

// A tamperable provider so tests can corrupt stored records post-append.
function tamperableProvider() {
  const store = [];
  return {
    store,
    name: 'tamperable',
    append: (ns, r) => (store.push(r), Promise.resolve()),
    scan: () => Promise.resolve(store.slice()),
    get: (ns, id) => Promise.resolve(store.find((r) => r.auditId === id) || null),
    count: () => store.length,
    tail: () => (store.length ? store[store.length - 1] : null),
    health: () => ({ ok: true }),
  };
}

// ── immutable snapshot ────────────────────────────────────────────────────────

test('hardening: snapshot() is deeply immutable', async () => {
  const A = createAuditPlatform({ clock: makeClock() });
  const rec = await A.audit.record({ action: 'a', metadata: { k: 1 } });
  const snap = await A.audit.snapshot('default', rec.auditId);
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.metadata));
  assert.throws(() => {
    snap.action = 'x';
  }, TypeError);
  assert.equal(await A.audit.snapshot('default', 'nope'), null);
});

// ── startup + provider verification ─────────────────────────────────────────────

test('hardening: verifyStartup + verifyProvider on a healthy store', async () => {
  const A = createAuditPlatform({ clock: makeClock() });
  assert.equal(A.audit.verifyStartup().ok, true);
  for (let i = 0; i < 5; i++) await A.audit.record({ action: 'a' + i });
  const v = await A.audit.verifyProvider('default');
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test('hardening: verifyProvider detects a non-contiguous sequence', async () => {
  const provider = tamperableProvider();
  const A = createAuditPlatform({ clock: makeClock(), provider });
  await A.audit.record({ action: 'a' });
  await A.audit.record({ action: 'b' });
  // Corrupt the stored sequence of the second record.
  provider.store[1] = { ...provider.store[1], sequence: 99 };
  const v = await A.audit.verifyProvider('default');
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.reason === 'non-contiguous sequence'));
});

// ── chain reconciliation + recovery boundary ────────────────────────────────────

test('hardening: reconcile/recover report the intact boundary without rewriting', async () => {
  const provider = tamperableProvider();
  const A = createAuditPlatform({ clock: makeClock(), provider });
  for (let i = 0; i < 5; i++) {
    await A.audit.record({ action: 'a' + i });
  }
  // Clean chain → fully intact.
  let r = await A.audit.reconcile('default');
  assert.equal(r.ok, true);
  assert.equal(r.lastGoodSequence, 4);
  // Tamper record at index 2 → intact prefix is 0..1.
  provider.store[2] = { ...provider.store[2], checksum: 'deadbeef'.padEnd(64, '0') };
  r = await A.audit.reconcile('default');
  assert.equal(r.ok, false);
  assert.equal(r.lastGoodSequence, 1);
  assert.equal(r.firstBreak.sequence, 2);
  const rec = await A.audit.recover('default');
  assert.equal(rec.intactThrough, 1);
  assert.equal(rec.total, 5); // history is NOT rewritten/deleted
  assert.equal(provider.store.length, 5);
});

// ── query-determinism verification ──────────────────────────────────────────────

test('hardening: verifyQuery confirms deterministic results', async () => {
  const A = createAuditPlatform({ clock: makeClock() });
  for (let i = 0; i < 6; i++)
    await A.audit.record({ action: 'a', correlationId: i % 2 ? 'x' : 'y' });
  const v = await A.audit.verifyQuery({ filter: { correlationId: 'x' } });
  assert.equal(v.ok, true);
  assert.equal(v.count, 3);
});

// ── corruption detection via verify + metric ────────────────────────────────────

test('hardening: verify flags corruption and increments integrityFailures', async () => {
  const provider = tamperableProvider();
  const A = createAuditPlatform({ clock: makeClock(), provider });
  await A.audit.record({ action: 'a' });
  await A.audit.record({ action: 'b' });
  provider.store[0] = { ...provider.store[0], checksum: 'deadbeef'.padEnd(64, '0') };
  const v = await A.audit.verify();
  assert.equal(v.ok, false);
  const m = A.audit.metrics();
  assert.ok(m.integrityFailures >= 1);
  assert.ok(m.checksumFailures >= 1);
});

// ── namespace consistency / isolation ───────────────────────────────────────────

test('hardening: namespaces keep independent, verifiable chains', async () => {
  const A = createAuditPlatform({ clock: makeClock() });
  await A.audit.record({ action: 'a1' }, { namespace: 'ns1' });
  await A.audit.record({ action: 'a2' }, { namespace: 'ns1' });
  await A.audit.record({ action: 'b1' }, { namespace: 'ns2' });
  assert.equal((await A.audit.query({}, { namespace: 'ns1' })).length, 2);
  assert.equal((await A.audit.query({}, { namespace: 'ns2' })).length, 1);
  assert.equal((await A.audit.verify({ namespace: 'ns1' })).ok, true);
  assert.equal((await A.audit.verify({ namespace: 'ns2' })).ok, true);
  assert.equal((await A.audit.reconcile('ns1')).lastGoodSequence, 1);
});

// ── lifecycle + query history ────────────────────────────────────────────────────

test('hardening: lifecycle + query history recorded and bounded', async () => {
  const A = createAuditPlatform({ clock: makeClock(), historyLimit: 5 });
  await A.audit.record({ action: 'a' });
  await A.audit.verify();
  const life = A.audit.history().map((h) => h.type);
  assert.ok(life.includes('recorded') && life.includes('verified'));
  for (let i = 0; i < 10; i++) await A.audit.query({ filter: { action: 'a' } });
  assert.ok(A.audit.queryHistory().length <= 5); // ring-bounded
});

// ── diagnostics ──────────────────────────────────────────────────────────────

test('hardening: diagnostics expose chain + startup + metrics', async () => {
  const A = createAuditPlatform({ clock: makeClock() });
  for (let i = 0; i < 3; i++) await A.audit.record({ action: 'a' + i });
  const d = await A.audit.diagnostics('default');
  assert.equal(d.namespaceCount, 3);
  assert.equal(d.startup.ok, true);
  assert.equal(d.chain.ok, true);
  assert.equal(d.chain.lastGoodSequence, 2);
  assert.ok(d.metrics);
});

// ── stress ───────────────────────────────────────────────────────────────────

test('hardening: stress — 3000 records reconcile as one intact chain', async () => {
  const clock = makeClock(1000);
  const A = createAuditPlatform({ clock });
  for (let i = 0; i < 3000; i++) {
    await A.audit.record({ action: 'evt', correlationId: 'c' + (i % 5) });
    clock.tick();
  }
  const r = await A.audit.reconcile('default');
  assert.equal(r.ok, true);
  assert.equal(r.lastGoodSequence, 2999);
  assert.equal((await A.audit.verifyProvider('default')).ok, true);
});
