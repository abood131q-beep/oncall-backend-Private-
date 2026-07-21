'use strict';

/**
 * identityShadowMiddleware.test.js — Phase 20.b
 *
 * Verifies the HTTP identity-shadow observer: it runs comparisons, NEVER mutates req/res, NEVER
 * throws, ALWAYS calls next(), and observes on every request (incl. token-bearing ones). sqlite-free.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'identity-shadow-mw-secret';

const auth = require('../../src/middleware/auth');
const { createIdentityShadowMiddleware } = require('../../src/middleware/identityShadowMiddleware');

const services = {
  generateJWT: auth.generateJWT,
  verifyJWT: auth.verifyJWT,
  ADMIN_PHONES: ['999'],
  logger: { info() {}, warn() {} },
};

function fakeReqRes(headers = {}) {
  const req = { id: 'req-1', headers, user: undefined };
  const res = {};
  const snapshot = JSON.stringify({ req, res });
  return { req, res, snapshot };
}

test('observer calls next() and does not mutate req/res (no token)', () => {
  const mw = createIdentityShadowMiddleware(services);
  const { req, res } = fakeReqRes({});
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.user, undefined); // never sets identity
  assert.deepEqual(res, {}); // never touches response
});

test('observer runs a comparison on every request (otp) and on token requests', () => {
  const mw = createIdentityShadowMiddleware(services);
  const token = auth.generateJWT({ phone: '999', type: 'passenger', role: 'admin' });
  const { req, res } = fakeReqRes({ authorization: `Bearer ${token}` });
  mw(req, res, () => {});
  const rep = mw.shadow.report();
  assert.ok(rep.comparisons >= 2, 'should compare otp + token ops');
  assert.equal(rep.mismatches, 0);
  assert.equal(rep.verificationFailures, 0);
});

test('observer NEVER throws even if the token is garbage', () => {
  const mw = createIdentityShadowMiddleware(services);
  const { req, res } = fakeReqRes({ 'x-session-token': 'not-a-real-token' });
  let called = false;
  assert.doesNotThrow(() => mw(req, res, () => { called = true; }));
  assert.equal(called, true);
  assert.equal(req.user, undefined);
});

test('observer returns legacy result only (shadow non-authoritative)', () => {
  const mw = createIdentityShadowMiddleware(services);
  // The middleware returns nothing to the request; identity is untouched.
  const { req, res } = fakeReqRes({ authorization: 'Bearer x.y.z' });
  const out = mw(req, res, () => 'NEXT');
  assert.equal(out, undefined); // middleware itself returns nothing meaningful to the pipeline
  assert.equal(req.user, undefined);
});
