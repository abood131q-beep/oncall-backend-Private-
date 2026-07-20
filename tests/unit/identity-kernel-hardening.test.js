'use strict';

/**
 * Identity Kernel — production hardening tests (ADR-027 A-001). Additive:
 * immutable identity/session snapshots, startup + provider (namespace
 * consistency) verification, credential-integrity verification, session
 * reconciliation + stale cleanup, recovery of the active set, lifecycle history,
 * diagnostics, and the expired-sessions metric. Does not duplicate
 * identity-kernel.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIdentityPlatform, providers } = require('../../src/application/identity-kernel');

function makeClock(start = 1000) {
  const box = { now: start };
  const clock = () => box.now;
  clock.set = (n) => (box.now = n);
  return clock;
}

async function seeded(clock, opts = {}) {
  const I = createIdentityPlatform({
    clock,
    sessionTtlMs: opts.ttl || 100,
    provider: opts.provider,
  });
  await I.identity.register({ principal: 'u1', credentials: { secret: 'pw' }, roles: ['rider'] });
  const auth = await I.identity.authenticate({ principal: 'u1', credentials: { secret: 'pw' } });
  return { I, auth };
}

// ── immutable snapshots ─────────────────────────────────────────────────────────

test('hardening: snapshotIdentity (no hash) + snapshotSession are deeply immutable', async () => {
  const clock = makeClock();
  const { I, auth } = await seeded(clock);
  const idModel = await I.identity.resolve({ principal: 'u1' });
  const snapId = await I.identity.snapshotIdentity('default', idModel.context.identityId);
  assert.ok(Object.isFrozen(snapId));
  assert.equal('credentialHash' in snapId, false); // never exposed
  assert.throws(() => {
    snapId.principal = 'x';
  }, TypeError);
  const snapSess = await I.identity.snapshotSession('default', auth.session.sessionId);
  assert.ok(Object.isFrozen(snapSess));
  assert.equal(snapSess.identityId, idModel.context.identityId);
  assert.equal(await I.identity.snapshotIdentity('default', 'nope'), null);
});

// ── startup + provider + credential verification ────────────────────────────────

test('hardening: verifyStartup + verifyProvider + verifyCredentialIntegrity', async () => {
  const clock = makeClock();
  const { I } = await seeded(clock);
  assert.equal(I.identity.verifyStartup().ok, true);
  assert.equal((await I.identity.verifyProvider('default')).ok, true);
  assert.equal((await I.identity.verifyCredentialIntegrity('default')).ok, true);
});

test('hardening: verifyProvider detects a session referencing an unknown identity', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const { I } = await seeded(clock, { provider });
  // Inject a dangling session directly into the provider.
  await provider.putSession('default', {
    sessionId: 'ghost',
    identityId: 'missing',
    state: 'active',
    expiresAt: 9e15,
  });
  const v = await I.identity.verifyProvider('default');
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.reason.includes('unknown identity')));
});

test('hardening: verifyCredentialIntegrity flags a malformed credential hash', async () => {
  const clock = makeClock();
  const provider = providers.createMemoryProvider();
  const { I } = await seeded(clock, { provider });
  const idModel = await I.identity.resolve({ principal: 'u1' });
  const stored = await provider.getIdentity('default', idModel.context.identityId);
  await provider.putIdentity('default', { ...stored, credentialHash: 'not-a-real-hash' });
  const v = await I.identity.verifyCredentialIntegrity('default');
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.reason === 'malformed credential hash'));
});

// ── session reconciliation / stale cleanup ──────────────────────────────────────

test('hardening: reconcileSessions settles expired sessions + counts them', async () => {
  const clock = makeClock(1000);
  const { I } = await seeded(clock, { ttl: 100 });
  await I.identity.authenticate({ principal: 'u1', credentials: { secret: 'pw' } }); // 2 sessions
  assert.equal(I.identity.metrics().activeSessions, 2);
  clock.set(1200); // both past expiry
  const r = await I.identity.reconcileSessions({ now: 1200 });
  assert.equal(r.expired, 2);
  assert.equal(I.identity.metrics().activeSessions, 0);
  assert.ok(I.identity.metrics().expiredSessions >= 2);
});

// ── recovery of the active set ──────────────────────────────────────────────────

test('hardening: recover rebuilds the active-session set from the provider', async () => {
  const clock = makeClock(1000);
  const provider = providers.createMemoryProvider();
  const { I: I1 } = await seeded(clock, { ttl: 100000, provider });
  // A fresh engine over the same provider (simulated restart) has an empty active set.
  const I2 = createIdentityPlatform({ clock, provider });
  assert.equal(I2.identity.metrics().activeSessions, 0);
  const rec = await I2.identity.recover({ now: 1000 });
  assert.equal(rec.recovered, 1);
  assert.equal(I2.identity.metrics().activeSessions, 1);
  void I1;
});

// ── namespace consistency ────────────────────────────────────────────────────

test('hardening: independent namespaces verify cleanly', async () => {
  const clock = makeClock();
  const I = createIdentityPlatform({ clock });
  await I.identity.register({ principal: 'a', credentials: { secret: 'p' } }, { namespace: 'ns1' });
  await I.identity.register({ principal: 'b', credentials: { secret: 'p' } }, { namespace: 'ns2' });
  assert.equal((await I.identity.verifyProvider('ns1')).ok, true);
  assert.equal((await I.identity.verifyProvider('ns2')).ok, true);
  const d = I.identity.diagnostics('ns1');
  assert.equal(d.identities, 1);
});

// ── lifecycle history + diagnostics ─────────────────────────────────────────────

test('hardening: lifecycle history recorded + bounded; diagnostics', async () => {
  const clock = makeClock();
  const I = createIdentityPlatform({ clock, historyLimit: 5 });
  await I.identity.register({ principal: 'u1', credentials: { secret: 'pw' } });
  const a = await I.identity.authenticate({ principal: 'u1', credentials: { secret: 'pw' } });
  await I.identity.revoke({ sessionId: a.session.sessionId });
  const life = I.identity.history().map((h) => h.type);
  assert.ok(
    life.includes('registered') && life.includes('authenticated') && life.includes('revoked')
  );
  for (let i = 0; i < 10; i++)
    await I.identity.authenticate({ principal: 'u1', credentials: { secret: 'pw' } });
  assert.ok(I.identity.history().length <= 5); // ring-bounded
  const d = I.identity.diagnostics();
  assert.equal(d.identities, 1);
  assert.ok(d.startup.ok);
});

// ── expired-session metric via refresh path ─────────────────────────────────────

test('hardening: refresh on an expired session settles it + increments expiredSessions', async () => {
  const clock = makeClock(1000);
  const { I, auth } = await seeded(clock, { ttl: 100 });
  clock.set(1300);
  await assert.rejects(
    () => I.identity.refresh({ sessionId: auth.session.sessionId, token: auth.session.token }),
    /expired/
  );
  assert.ok(I.identity.metrics().expiredSessions >= 1);
});

// ── stress ───────────────────────────────────────────────────────────────────

test('hardening: stress — 500 identities + reconcile is consistent', async () => {
  const clock = makeClock(1000);
  const I = createIdentityPlatform({ clock, sessionTtlMs: 100 });
  for (let i = 0; i < 500; i++) {
    await I.identity.register({ principal: 'u' + i, credentials: { secret: 'pw' } });
    await I.identity.authenticate({ principal: 'u' + i, credentials: { secret: 'pw' } });
  }
  assert.equal(I.identity.metrics().activeSessions, 500);
  clock.set(2000);
  const r = await I.identity.reconcileSessions({ now: 2000 });
  assert.equal(r.expired, 500);
  assert.equal(I.identity.metrics().activeSessions, 0);
  assert.equal((await I.identity.verifyProvider('default')).ok, true);
});
