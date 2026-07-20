'use strict';

/**
 * Enterprise Identity Kernel tests (Phase 14.8 / ADR-027) — covers every required
 * category: unit (identity, session, principal context), authentication, session
 * (refresh/expiry/revoke), provider, concurrency, stress, and failure injection,
 * plus events-via-port, credential integrity, and the SDK owner-scoped adapter
 * (namespace isolation + capability gates). Deterministic: clock injected. This
 * is the NEW Identity KERNEL (src/…/identity-kernel), distinct from the app's
 * identity bounded context.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIdentity, hashSecret } = require('../../src/domain/identity-kernel/identity');
const { createSession } = require('../../src/domain/identity-kernel/session');
const { buildContext } = require('../../src/domain/identity-kernel/principal');
const { createIdentityPlatform, providers } = require('../../src/application/identity-kernel');
const { createIdentityMetrics } = require('../../src/application/identity-kernel/metrics');
const { toIdentityPort } = require('../../src/application/identity-kernel/sdkAdapter');
const {
  IdentityValidationError,
  AuthenticationError,
  SessionError,
} = require('../../src/domain/identity-kernel/errors');

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

// ── domain: identity + credential integrity ────────────────────────────────────

test('identity: credential hashing (no raw secret) + verify + public view', () => {
  const id = createIdentity({ principal: 'u1', credentials: { secret: 'pw' }, roles: ['r'] });
  assert.ok(id.credentialHash && id.credentialHash.length === 64);
  assert.equal(id.credentialHash, hashSecret(id.identityId, 'pw'));
  assert.ok(id.verifySecret('pw'));
  assert.ok(!id.verifySecret('nope'));
  assert.ok(!id.verifySecret(undefined));
  assert.equal('credentialHash' in id.toPublic(), false); // never leaked
  assert.equal('credentialHash' in id.toModel(), true); // provider persistence only
  assert.throws(() => createIdentity({}), IdentityValidationError);
});

// ── domain: session ────────────────────────────────────────────────────────────

test('session: lifecycle live/expire/refresh/revoke', () => {
  const clock = makeClock(1000);
  const s = createSession({ identityId: 'i', principal: 'p', ttlMs: 100 }, { clock });
  assert.ok(s.isLive(1050));
  assert.ok(!s.isLive(1200));
  assert.equal(s.settleExpiry(1200), true);
  assert.equal(s.state, 'expired');
  const s2 = createSession({ identityId: 'i', principal: 'p', ttlMs: 100 }, { clock });
  s2.refresh(1050, 100);
  assert.equal(s2.expiresAt, 1150);
  s2.revoke();
  assert.equal(s2.state, 'revoked');
  assert.ok(!s2.isLive(1050));
});

// ── domain: principal context ───────────────────────────────────────────────────

test('principal: deterministic frozen authorization context', () => {
  const clock = makeClock(1000);
  const id = createIdentity({
    principal: 'u1',
    roles: ['rider'],
    permissions: ['trip:create'],
    claims: { n: 1 },
    tenant: 't1',
  });
  const s = createSession({ identityId: id.identityId, principal: 'u1', ttlMs: 100 }, { clock });
  const ctx = buildContext(id, s, { now: 1050 });
  assert.ok(Object.isFrozen(ctx));
  assert.ok(Object.isFrozen(ctx.roles));
  assert.deepEqual(ctx.roles, ['rider']);
  assert.deepEqual(ctx.permissions, ['trip:create']);
  assert.equal(ctx.tenant, 't1');
  assert.equal(ctx.authenticated, true);
  assert.equal(buildContext(id, null, { now: 1050 }).authenticated, false);
});

// ── unit: metrics ──────────────────────────────────────────────────────────────

test('metrics: counters + prometheus', () => {
  const m = createIdentityMetrics({ clock: () => 0 });
  m.bindGauges({ activeSessions: () => 3 });
  m.recordIdentity();
  m.recordAuthAttempt();
  m.recordAuthFailure();
  m.recordRefresh();
  m.recordRevocation();
  const s = m.snapshot();
  assert.equal(s.identities, 1);
  assert.equal(s.authFailures, 1);
  assert.equal(s.activeSessions, 3);
  assert.match(m.prometheus(), /identity_identities_total 1/);
  assert.match(m.prometheus(), /identity_active_sessions 3/);
});

// ── provider + future extension points ─────────────────────────────────────────

test('provider: memory stores identities/sessions; future providers declared', async () => {
  const mem = providers.createMemoryProvider();
  await mem.putIdentity('n', { identityId: 'i1', principal: 'p1' });
  assert.equal((await mem.getIdentityByPrincipal('n', 'p1')).identityId, 'i1');
  assert.equal((await mem.getIdentity('n', 'i1')).principal, 'p1');
  await mem.putSession('n', { sessionId: 's1', identityId: 'i1' });
  assert.equal((await mem.getSession('n', 's1')).identityId, 'i1');
  assert.equal(await mem.removeSession('n', 's1'), true);
  assert.ok(providers.FUTURE_PROVIDERS.includes('oidc'));
  const p = providers.futureProvider('ldap');
  assert.equal(p.planned, true);
  assert.throws(() => p.putIdentity('n', {}), /extension point/);
});

// ── authentication ──────────────────────────────────────────────────────────────

test('identity: register + authenticate success yields session + context; events', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const I = createIdentityPlatform({ clock, publisher: pub });
  const reg = await I.identity.register({
    principal: 'u1',
    credentials: { secret: 'pw' },
    roles: ['rider'],
  });
  assert.equal('credentialHash' in reg, false); // registration returns no credential
  const { session, context } = await I.identity.authenticate({
    principal: 'u1',
    credentials: { secret: 'pw' },
  });
  assert.equal(session.state, 'active');
  assert.ok(session.token);
  assert.equal(context.authenticated, true);
  assert.deepEqual(context.roles, ['rider']);
  const types = pub.events.map((e) => e.type);
  assert.ok(
    types.includes('IdentityRegistered') &&
      types.includes('Authenticated') &&
      types.includes('SessionCreated')
  );
  assert.ok(pub.events.every((e) => e.producer === 'identity'));
  // No event leaks a credential/token.
  assert.ok(pub.events.every((e) => !('credentialHash' in e.payload) && !('token' in e.payload)));
});

test('identity: duplicate principal + bad credentials are typed errors', async () => {
  const clock = makeClock();
  const pub = recordingPublisher();
  const I = createIdentityPlatform({ clock, publisher: pub });
  await I.identity.register({ principal: 'u1', credentials: { secret: 'pw' } });
  await assert.rejects(
    () => I.identity.register({ principal: 'u1', credentials: { secret: 'x' } }),
    IdentityValidationError
  );
  await assert.rejects(
    () => I.identity.authenticate({ principal: 'u1', credentials: { secret: 'wrong' } }),
    AuthenticationError
  );
  await assert.rejects(
    () => I.identity.authenticate({ principal: 'ghost', credentials: { secret: 'pw' } }),
    AuthenticationError
  );
  assert.ok(pub.events.filter((e) => e.type === 'AuthenticationFailed').length === 2);
  assert.ok(I.identity.metrics().authFailures === 2);
});

// ── session management ──────────────────────────────────────────────────────────

test('identity: resolve, refresh (token-validated), expiry, revoke', async () => {
  const clock = makeClock(1000);
  const I = createIdentityPlatform({ clock, sessionTtlMs: 100 });
  await I.identity.register({ principal: 'u1', credentials: { secret: 'pw' }, permissions: ['x'] });
  const { session } = await I.identity.authenticate({
    principal: 'u1',
    credentials: { secret: 'pw' },
  });
  let r = await I.identity.resolve({ sessionId: session.sessionId });
  assert.equal(r.ok, true);
  assert.deepEqual(r.context.permissions, ['x']);
  await assert.rejects(
    () => I.identity.refresh({ sessionId: session.sessionId, token: 'bad' }),
    SessionError
  );
  const ref = await I.identity.refresh({
    sessionId: session.sessionId,
    token: session.token,
    ttlMs: 100,
  });
  assert.equal(ref.expiresAt, 1100);
  clock.set(1300);
  r = await I.identity.resolve({ sessionId: session.sessionId });
  assert.equal(r.ok, false);
  assert.equal(r.context.authenticated, false);
  await assert.rejects(
    () => I.identity.refresh({ sessionId: session.sessionId, token: session.token }),
    SessionError
  );
});

test('identity: revoke ends the session', async () => {
  const clock = makeClock(1000);
  const pub = recordingPublisher();
  const I = createIdentityPlatform({ clock, publisher: pub });
  await I.identity.register({ principal: 'u1', credentials: { secret: 'pw' } });
  const { session } = await I.identity.authenticate({
    principal: 'u1',
    credentials: { secret: 'pw' },
  });
  assert.equal(await I.identity.revoke({ sessionId: session.sessionId }), true);
  const r = await I.identity.resolve({ sessionId: session.sessionId });
  assert.equal(r.ok, false);
  assert.ok(pub.events.some((e) => e.type === 'SessionRevoked'));
  assert.equal(I.identity.metrics().revocations, 1);
});

// ── resolve by principal (authorization context without a session) ─────────────

test('identity: resolve by principal yields roles/permissions (unauthenticated)', async () => {
  const clock = makeClock();
  const I = createIdentityPlatform({ clock });
  await I.identity.register({
    principal: 'u1',
    credentials: { secret: 'pw' },
    roles: ['admin'],
    permissions: ['*'],
  });
  const r = await I.identity.resolve({ principal: 'u1' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.context.roles, ['admin']);
  assert.equal(r.context.authenticated, false);
  assert.deepEqual(await I.identity.resolve({ principal: 'ghost' }), { ok: false, context: null });
});

// ── SDK adapter: namespace isolation + capability gates ─────────────────────────

test('identity SDK adapter: namespace isolation + capability enforcement', async () => {
  const clock = makeClock();
  const I = createIdentityPlatform({ clock });
  const portA = toIdentityPort(I.identity, { owner: 'ext-a' });
  const portB = toIdentityPort(I.identity, { owner: 'ext-b' });
  await portA.register({ principal: 'shared', credentials: { secret: 'p' } });
  await assert.rejects(
    () => portB.authenticate({ principal: 'shared', credentials: { secret: 'p' } }),
    AuthenticationError
  );
  const a = await portA.authenticate({ principal: 'shared', credentials: { secret: 'p' } });
  assert.ok(a.session);
  const readonly = toIdentityPort(I.identity, { owner: 'ext-c', canAuthenticate: false });
  await assert.rejects(
    async () => readonly.authenticate({ principal: 'x', credentials: { secret: 'p' } }),
    /identity:authenticate/
  );
});

// ── failure injection ──────────────────────────────────────────────────────────

test('identity: a provider failure surfaces + increments providerFailures', async () => {
  const clock = makeClock();
  const mem = providers.createMemoryProvider();
  let fail = false;
  const flaky = {
    ...mem,
    putIdentity: (ns, m) =>
      fail ? Promise.reject(new Error('store down')) : mem.putIdentity(ns, m),
  };
  const I = createIdentityPlatform({ clock, provider: flaky });
  fail = true;
  await assert.rejects(
    () => I.identity.register({ principal: 'u1', credentials: { secret: 'p' } }),
    /store down/
  );
  assert.ok(I.identity.metrics().providerFailures >= 1);
});

// ── concurrency + stress ────────────────────────────────────────────────────────

test('identity: concurrent authentications each get a distinct live session', async () => {
  const clock = makeClock();
  let n = 0;
  const I = createIdentityPlatform({ clock, tokenFactory: () => `tok_${n++}` });
  await I.identity.register({ principal: 'u1', credentials: { secret: 'pw' } });
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      I.identity.authenticate({ principal: 'u1', credentials: { secret: 'pw' } })
    )
  );
  const ids = new Set(results.map((r) => r.session.sessionId));
  assert.equal(ids.size, 10);
  assert.equal(I.identity.metrics().activeSessions, 10);
});

test('identity: stress — 1000 identities register + authenticate', async () => {
  const clock = makeClock();
  const I = createIdentityPlatform({ clock });
  for (let i = 0; i < 1000; i++) {
    await I.identity.register({ principal: 'u' + i, credentials: { secret: 'pw' + i } });
  }
  const { context } = await I.identity.authenticate({
    principal: 'u999',
    credentials: { secret: 'pw999' },
  });
  assert.equal(context.principal, 'u999');
  assert.equal(I.identity.metrics().identities, 1000);
});
