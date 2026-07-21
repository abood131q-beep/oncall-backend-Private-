'use strict';

/**
 * identityShadow.test.js — Phase 20.a
 *
 * Verifies the Identity Shadow: legacy is authoritative, the shadow returns ONLY the legacy result,
 * never throws (even when the kernel path throws), reaches 100% parity on the pure surface, records
 * mismatches with the required metadata, exposes per-category parity metrics, and is inert when
 * disabled. sqlite-free.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'identity-shadow-test-secret';

const { generateJWT, verifyJWT } = require('../../src/middleware/auth');
const {
  createIdentityShadow,
  createLegacyIdentitySource,
  createKernelIdentitySource,
} = require('../../src/platform-adapters/identity');
const { attachIdentityShadow } = require('../../src/enterprise/identityShadow');

const adminPhones = ['555'];
const primitives = { generateJWT, verifyJWT, adminPhones, requireOtp: true };
const payloads = [
  { phone: '111', type: 'passenger', role: 'passenger' },
  { phone: '555', type: 'passenger', role: 'passenger' }, // admin by phone
  { phone: '222', type: 'driver', role: 'driver', driverId: 7 },
];
const tokens = [...payloads.map((p) => generateJWT(p)), 'x.y.z', null];

test('shadow returns the LEGACY result for every operation (kernel never authoritative)', () => {
  const s = attachIdentityShadow({ platformIdentity: true, shadowIdentity: true, primitives });
  const legacy = createLegacyIdentitySource(primitives);
  for (const p of payloads) {
    assert.equal(s.shadowIsAdmin(p), legacy.isAdmin(p));
    assert.deepEqual(s.shadowResolvePrincipal(p), legacy.resolvePrincipal(p));
  }
  assert.equal(s.shadowOtpRequired(), legacy.otpRequired());
});

test('shadow reaches 100% parity on the pure surface (0 mismatch, 0 failure)', () => {
  const s = attachIdentityShadow({ platformIdentity: true, shadowIdentity: true, primitives });
  const r = s.verifyAll({ tokens, payloads });
  assert.equal(r.overallParityPct, 100);
  assert.equal(r.mismatches, 0);
  assert.equal(r.verificationFailures, 0);
  assert.equal(r.jwtParityPct, 100);
  assert.equal(r.authorizationParityPct, 100);
  assert.equal(r.otpParityPct, 100);
});

test('shadow NEVER throws when the kernel path throws — records a verification failure', () => {
  const legacy = createLegacyIdentitySource(primitives);
  // A kernel source whose verify() throws.
  const brokenKernel = {
    ...createKernelIdentitySource({
      tokenPort: { verifyAccessToken: () => { throw new Error('boom'); }, issueAccessToken: () => 'a.b.c' },
      otpPort: { isRequired: () => true },
      adminPhones,
    }),
  };
  const s = createIdentityShadow({ legacy, kernel: brokenKernel, enabled: () => true });
  let result;
  assert.doesNotThrow(() => {
    result = s.shadowVerify(tokens[0], { requestId: 'r1' });
  });
  // still returns the legacy result
  assert.deepEqual(result, legacy.verify(tokens[0]));
  const rep = s.report();
  assert.ok(rep.verificationFailures >= 1);
  assert.equal(rep.mismatches_log[0].differenceCategory, 'kernel-exception');
  assert.equal(rep.mismatches_log[0].severity, 'critical');
  assert.equal(rep.mismatches_log[0].requestId, 'r1');
});

test('a real mismatch is recorded with full metadata + redaction', () => {
  const legacy = createLegacyIdentitySource(primitives);
  // Kernel that disagrees on admin (returns opposite).
  const kernel = {
    ...createKernelIdentitySource({
      tokenPort: { verifyAccessToken: verifyJWT, issueAccessToken: generateJWT },
      otpPort: { isRequired: () => true },
      adminPhones,
    }),
    isAdmin: () => 'WRONG',
  };
  const s = createIdentityShadow({ legacy, kernel, enabled: () => true });
  s.shadowIsAdmin({ phone: '555', role: 'passenger' }, { requestId: 'rid-9' });
  const rep = s.report();
  assert.equal(rep.mismatches, 1);
  assert.equal(rep.authorizationParityPct, 0);
  const m = rep.mismatches_log.find((x) => x.operation === 'isAdmin');
  assert.equal(m.requestId, 'rid-9');
  assert.equal(m.category, 'authz');
  assert.equal(m.severity, 'critical');
  assert.ok('rootCauseHypothesis' in m && 'differenceCategory' in m && 'at' in m);
});

test('disabled shadow is inert (no comparisons) but still returns legacy', () => {
  const s = attachIdentityShadow({ platformIdentity: true, shadowIdentity: false, primitives });
  const legacy = createLegacyIdentitySource(primitives);
  const out = s.shadowIsAdmin(payloads[1]);
  assert.equal(out, legacy.isAdmin(payloads[1]));
  assert.equal(s.report().comparisons, 0);
});

test('metrics expose all required parity dimensions', () => {
  const s = attachIdentityShadow({ platformIdentity: true, shadowIdentity: true, primitives });
  const r = s.verifyAll({ tokens, payloads });
  for (const k of ['overallParityPct', 'jwtParityPct', 'authorizationParityPct', 'otpParityPct', 'refreshParityPct', 'repositoryParityPct', 'socketParityPct', 'latency', 'confidenceLevel', 'coveragePct']) {
    assert.ok(k in r, `report missing ${k}`);
  }
});

test('unexercised categories report parityPct=null (honest), not a misleading 100', () => {
  const s = attachIdentityShadow({ platformIdentity: true, shadowIdentity: true, primitives });
  const r = s.verifyAll({ tokens, payloads }); // pure surface only — no DB
  assert.equal(r.refreshParityPct, null, 'refresh not exercised ⇒ null');
  assert.equal(r.repositoryParityPct, null, 'repository not exercised ⇒ null');
  assert.equal(r.categories.refresh.comparisons, 0);
});

test('async DB methods: shadowVerifyRefresh compares, records under refresh, returns legacy, never throws', async () => {
  const legacy = createLegacyIdentitySource({ ...primitives, verifyRefreshToken: (t) => Promise.resolve(t === 'good' ? { phone: '1' } : null) });
  const kernel = {
    ...createKernelIdentitySource({
      tokenPort: { verifyAccessToken: verifyJWT, issueAccessToken: generateJWT, verifyRefreshToken: (t) => Promise.resolve(t === 'good' ? { phone: '1' } : null) },
      otpPort: { isRequired: () => true },
      identityRepositoryPort: { findUserByPhone: () => Promise.resolve(null), findDriverByPhone: () => Promise.resolve(null) },
      adminPhones,
    }),
  };
  const s = createIdentityShadow({ legacy, kernel, enabled: () => true });
  const out = await s.shadowVerifyRefresh('good', { requestId: 'rt' });
  assert.deepEqual(out, { phone: '1' }); // legacy value returned
  const rep = s.report();
  assert.equal(rep.categories.refresh.comparisons, 1);
  assert.equal(rep.refreshParityPct, 100);
  // kernel throwing is captured, never propagated
  const kBad = { ...kernel, verifyRefresh: () => { throw new Error('db down'); } };
  const s2 = createIdentityShadow({ legacy, kernel: kBad, enabled: () => true });
  await assert.doesNotReject(() => s2.shadowVerifyRefresh('good', { requestId: 'rt2' }));
  assert.ok(s2.report().verificationFailures >= 1);
});
