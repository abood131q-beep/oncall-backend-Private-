'use strict';

/**
 * Policy Engine — production hardening tests (ADR-025 A-001). Additive:
 * immutable snapshots, startup + provider (checksum reconciliation) + cache
 * verification, corruption/orphan/namespace-consistency detection, provider-
 * failure recovery, lifecycle + evaluation history, diagnostics, and expanded
 * metrics. Does not duplicate policy.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPolicyPlatform, providers } = require('../../src/application/policy');

function makeClock(start = 1000) {
  const box = { now: start };
  const clock = () => box.now;
  clock.set = (n) => (box.now = n);
  return clock;
}

// ── immutable snapshot ────────────────────────────────────────────────────────

test('hardening: snapshot() is deeply immutable', async () => {
  const pol = createPolicyPlatform({ clock: makeClock() });
  const p = await pol.policy.register({ name: 'a', scope: 's', effect: 'allow', condition: true });
  const snap = pol.policy.snapshot('default', p.policyId);
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.metadata));
  assert.throws(() => {
    snap.effect = 'deny';
  }, TypeError);
  assert.equal(pol.policy.snapshot('default', 'nope'), null);
});

// ── startup + provider verification (checksum reconciliation) ──────────────────

test('hardening: verifyStartup + verifyProvider agree with the engine', async () => {
  const pol = createPolicyPlatform({ clock: makeClock() });
  assert.equal(pol.policy.verifyStartup().ok, true);
  await pol.policy.register({ name: 'a', scope: 's', effect: 'allow', condition: true });
  const v = await pol.policy.verifyProvider('default');
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test('hardening: verifyProvider detects drift, missing, corrupt, and orphan records', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const pol = createPolicyPlatform({ clock, provider });
  const p = await pol.policy.register({ name: 'a', scope: 's', effect: 'allow', condition: true });
  // Tamper the provider copy: checksum drift.
  await provider.put('default', {
    ...(await provider.get('default', p.policyId)),
    checksum: 'deadbeef',
  });
  let v = await pol.policy.verifyProvider('default');
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.reason === 'checksum drift'));
  // Corrupt record (no checksum).
  await provider.put('default', { policyId: p.policyId, name: 'a' });
  v = await pol.policy.verifyProvider('default');
  assert.ok(v.issues.some((i) => i.reason.includes('corrupt')));
  // Orphan in provider.
  await provider.put('default', { policyId: 'ghost', checksum: 'x' });
  v = await pol.policy.verifyProvider('default');
  assert.ok(v.issues.some((i) => i.reason.includes('orphan')));
  // Missing in provider.
  await provider.remove('default', p.policyId);
  v = await pol.policy.verifyProvider('default');
  assert.ok(v.issues.some((i) => i.reason === 'missing in provider'));
  assert.ok(pol.policy.metrics().integrityFailures >= 1);
});

// ── provider-failure recovery ──────────────────────────────────────────────────

test('hardening: recover() re-persists after a provider write failure', async () => {
  const clock = makeClock();
  const mem = providers.createMemoryProvider();
  let failPut = false;
  const flaky = {
    ...mem,
    put: (ns, m) => (failPut ? Promise.reject(new Error('store down')) : mem.put(ns, m)),
  };
  const pol = createPolicyPlatform({ clock, provider: flaky });
  await pol.policy.register({ name: 'a', scope: 's', effect: 'allow', condition: true });
  // Simulate a failed write for a second policy.
  failPut = true;
  await assert.rejects(
    () => pol.policy.register({ name: 'b', scope: 's', effect: 'deny', condition: true }),
    /store down/
  );
  assert.ok(pol.policy.metrics().providerFailures >= 1);
  // The engine still holds 'b' in memory (authoritative); recover re-persists it.
  failPut = false;
  const rec = await pol.policy.recover('default');
  assert.equal(rec.ok, true);
  assert.ok(rec.repaired >= 2);
  const v = await pol.policy.verifyProvider('default');
  assert.equal(v.ok, true);
});

// ── decision-cache verification ─────────────────────────────────────────────────

test('hardening: verifyCache confirms cached decisions match fresh evaluation', async () => {
  const pol = createPolicyPlatform({ clock: makeClock() });
  await pol.policy.register({ name: 'a', scope: 's', effect: 'allow', condition: true });
  await pol.policy.evaluate({ scope: 's', x: 1 });
  await pol.policy.evaluate({ scope: 's', x: 2 });
  const v = pol.policy.verifyCache();
  assert.equal(v.ok, true);
  assert.ok(v.size >= 2);
});

// ── namespace consistency ────────────────────────────────────────────────────

test('hardening: namespaces are isolated + independently verifiable', async () => {
  const pol = createPolicyPlatform({ clock: makeClock() });
  await pol.policy.register({
    namespace: 'ns1',
    name: 'a',
    scope: 's',
    effect: 'allow',
    condition: true,
  });
  await pol.policy.register({
    namespace: 'ns2',
    name: 'b',
    scope: 's',
    effect: 'deny',
    condition: true,
  });
  assert.equal((await pol.policy.evaluate({ namespace: 'ns1', scope: 's' })).allowed, true);
  assert.equal((await pol.policy.evaluate({ namespace: 'ns2', scope: 's' })).allowed, false);
  assert.equal((await pol.policy.verifyProvider('ns1')).ok, true);
  assert.equal((await pol.policy.verifyProvider('ns2')).ok, true);
});

// ── lifecycle + evaluation history ──────────────────────────────────────────────

test('hardening: lifecycle + evaluation history are recorded and bounded', async () => {
  const pol = createPolicyPlatform({ clock: makeClock(), historyLimit: 5 });
  const p = await pol.policy.register({ name: 'a', scope: 's', effect: 'allow', condition: true });
  await pol.policy.disable('default', p.policyId);
  await pol.policy.enable('default', p.policyId);
  const life = pol.policy.history().map((h) => h.type);
  assert.ok(life.includes('registered') && life.includes('disabled') && life.includes('enabled'));
  for (let i = 0; i < 10; i++) await pol.policy.evaluate({ scope: 's', i });
  assert.ok(pol.policy.evaluationHistory().length <= 5); // ring-bounded
});

// ── diagnostics + expanded metrics ──────────────────────────────────────────────

test('hardening: diagnostics + expanded metrics', async () => {
  const pol = createPolicyPlatform({ clock: makeClock() });
  const p = await pol.policy.register({ name: 'a', scope: 's', effect: 'allow', condition: true });
  await pol.policy.register({ name: 'b', scope: 's', effect: 'deny', condition: true });
  await pol.policy.disable('default', p.policyId);
  const d = pol.policy.diagnostics();
  assert.equal(d.policies, 2);
  assert.equal(d.enabled, 1);
  assert.equal(d.disabled, 1);
  assert.ok(d.startup.ok);
  const m = pol.policy.metrics();
  assert.equal(m.enabled, 1);
  assert.equal(m.disabled, 1);
  assert.ok('providerFailures' in m && 'integrityFailures' in m && 'uptimeMs' in m);
});

// ── stress ───────────────────────────────────────────────────────────────────

test('hardening: stress — 1000 policies register + verify cleanly', async () => {
  const pol = createPolicyPlatform({ clock: makeClock() });
  for (let i = 0; i < 1000; i++) {
    await pol.policy.register({
      name: 'p' + i,
      scope: 's' + (i % 10),
      effect: i % 2 ? 'allow' : 'deny',
      condition: true,
    });
  }
  const v = await pol.policy.verifyProvider('default');
  assert.equal(v.ok, true);
  assert.equal(pol.policy.diagnostics().policies, 1000);
});
